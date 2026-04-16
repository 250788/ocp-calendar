import { v4 as uuidv4 } from 'uuid';
import acmClient from '../lib/acmClient.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Policy Service
 * Generates and manages ACM policies for scheduled OpenShift upgrades
 */
export class PolicyService {
  constructor() {
    this.policyNamespace = process.env.POLICY_NAMESPACE || 'openshift-gitops';
    this.cronjobNamespace = process.env.CRONJOB_NAMESPACE || 'openshift-upgrade';
  }

  /**
   * Generate cron schedule from event data
   * @param {string} scheduledDate - Date in YYYY-MM-DD format
   * @param {string} startTime - Time in HH:MM format (24h)
   * @returns {string} Cron expression (min hour day month weekday)
   */
  generateCronSchedule(scheduledDate, startTime) {
    const [year, month, day] = scheduledDate.split('-').map(Number);
    const [hour, minute] = startTime.split(':').map(Number);

    const date = new Date(year, month - 1, day, hour, minute);
    const cronExpression = `${minute} ${hour} ${date.getDate()} ${date.getMonth() + 1} *`;

    return cronExpression;
  }

  /**
   * Generate a safe name from cluster name
   * @param {string} clusterName
   * @returns {string}
   */
  sanitizeName(clusterName) {
    return clusterName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Generate a CronJob manifest for OpenShift upgrade
   * @param {Object} event - Event data
   * @returns {Object} CronJob object definition
   */
  generateCronJobDefinition(event) {
    const {
      id,
      title,
      cluster_name: clusterName,
      openshift_version: targetVersion,
      start_time: startTime,
      notes
    } = event;

    // Generate cron schedule: minute hour day month weekday
    // Run at the specified time on the scheduled date
    const cronSchedule = this.generateCronSchedule(event.scheduled_date, startTime);

    // Create a safe name for resources
    const safeClusterName = this.sanitizeName(clusterName);
    const cronJobName = `openshift-upgrade-${safeClusterName}-${id.substring(0, 8)}`;
    const serviceAccountName = `openshift-upgrade-${safeClusterName}-${id.substring(0, 4)}`;

    return {
      apiVersion: 'batch/v1',
      kind: 'CronJob',
      metadata: {
        name: cronJobName,
        namespace: this.cronjobNamespace,
        labels: {
          'app.kubernetes.io/component': 'cluster-upgrade',
          'app.kubernetes.io/created-by': 'cluster-upgrade-calendar',
          'cluster-name': safeClusterName,
          'upgrade-event-id': id
        },
        annotations: {
          'cluster-upgrade-calendar.event-title': title,
          'cluster-upgrade-calendar.target-version': targetVersion,
          ...(notes && { 'cluster-upgrade-calendar.notes': notes })
        }
      },
      spec: {
        schedule: cronSchedule,
        concurrencyPolicy: 'Forbid',
        startingDeadlineSeconds: 3600, // Allow up to 1 hour delay
        suspend: false,
        jobTemplate: {
          spec: {
            backoffLimit: 1,
            template: {
              metadata: {
                name: cronJobName
              },
              spec: {
                serviceAccountName: serviceAccountName,
                restartPolicy: 'OnFailure',
                containers: [
                  {
                    name: 'openshift-upgrade',
                    image: 'registry.redhat.io/openshift4/ose-cli:latest',
                    command: ['/bin/bash', '-c'],
                    args: [
                      `set -euo pipefail &&
                       echo "Starting OpenShift upgrade for cluster ${clusterName}" &&
                       oc get cluster version version -o jsonpath='{.status.desired.version}' &&
                       echo "Current version: \$(oc get cluster version version -o jsonpath='{.status.desired.version}')" &&
                       oc upgrade --to=${targetVersion} -- stabilization-timeout=20m --verify=health &&
                       echo "Upgrade completed successfully" ||
                       echo "Upgrade failed" && exit 1`
                    ],
                    env: [
                      {
                        name: 'OPENSHIFT_CLUSTER_NAME',
                        value: clusterName
                      },
                      {
                        name: 'TARGET_VERSION',
                        value: targetVersion
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      }
    };
  }

  /**
   * Generate placement rule for targeted managed cluster
   * @param {string} clusterName - Name of the managed cluster
   * @returns {Object} Placement definition
   */
  generatePlacementRule(clusterName) {
    const safeClusterName = this.sanitizeName(clusterName);

    return {
      placement: {
        name: `placement-${safeClusterName}`,
        clusterSelector: {
          matchLabels: {
            'name': clusterName,
            'vendor': 'OpenShift'
          }
        },
        policies: ['upgrade-cronjob']
      }
    };
  }

  /**
   * Create a complete ACM policy for an upgrade event
   * @param {Object} event - Event data from database
   * @returns {Object} Created/updated policy info
   */
  async createUpgradePolicy(event) {
    const policyId = `upgrade-policy-${this.sanitizeName(event.cluster_name)}-${event.id.substring(0, 8)}`;
    const safeClusterName = this.sanitizeName(event.cluster_name);

    // Derive the serviceAccountName here (same logic as generateCronJobDefinition)
    const serviceAccountName = `openshift-upgrade-${safeClusterName}-${event.id.substring(0, 4)}`;

    // Generate cronjob definition
    const cronJobDef = this.generateCronJobDefinition(event);

    // Build ConfigurationPolicy with the CronJob and its ServiceAccount
    const configurationPolicy = {
      apiVersion: 'policy.open-cluster-management.io/v1',
      kind: 'ConfigurationPolicy',
      metadata: {
        name: 'upgrade-cronjob'
      },
      spec: {
        remediationAction: 'enforce',
        pruneObjectBehavior: 'DeleteAll',
        'object-templates': [
          {
            complianceType: 'musthave',
            objectDefinition: {
              apiVersion: 'v1',
              kind: 'ServiceAccount',
              metadata: {
                name: serviceAccountName,
                namespace: this.cronjobNamespace
              },
              automountServiceAccountToken: true
            }
          },
          {
            complianceType: 'musthave',
            objectDefinition: cronJobDef
          }
        ]
      }
    };

    // Build placement rule and binding names
    const placementRuleName = `placement-${safeClusterName}-${event.id.substring(0, 8)}`;
    const placementBindingName = `binding-${safeClusterName}-${event.id.substring(0, 8)}`;

    // Assemble complete policy
    const policy = {
      metadataName: policyId,
      targetCluster: event.cluster_name,
      placementRuleName,
      placementBindingName,
      labels: {
        'app.kubernetes.io/name': 'cluster-upgrade-scheduler',
        'app.kubernetes.io/created-by': 'cluster-upgrade-calendar',
        'cluster-name': event.cluster_name,
        'upgrade-event-id': event.id,
        'openshift-version': event.openshift_version
      },
      policyTemplates: [{
        objectDefinition: configurationPolicy
      }]
    };

    try {
      // Check if policy already exists
      const existing = await acmClient.getPolicy(policyId, this.policyNamespace);

      if (existing) {
        logger.info('Policy already exists, updating:', { name: policyId });
        const result = await acmClient.updatePolicy(policyId, policy, this.policyNamespace);
        return {
          action: 'updated',
          name: policyId,
          ...result
        };
      } else {
        logger.info('Creating new policy:', { name: policyId });
        const result = await acmClient.createPolicy(policy, this.policyNamespace);
        return {
          action: 'created',
          name: policyId,
          ...result
        };
      }
    } catch (error) {
      logger.error('Failed to create/update policy:', {
        policyId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Delete an upgrade policy
   * @param {string} policyName - Name of the policy to delete
   * @returns {Object} Deletion result
   */
  async deleteUpgradePolicy(policyName) {
    try {
      if (!policyName) {
        return { success: true, message: 'No policy name provided' };
      }

      logger.info('Deleting policy:', { name: policyName });
      const result = await acmClient.deletePolicy(policyName, this.policyNamespace);

      // Also try to clean up resources on managed cluster
      // This depends on ACM's policy cleanup behavior
      await this.cleanupManagedClusterResources(policyName);

      return { success: true, ...result };
    } catch (error) {
      logger.error('Failed to delete policy:', { policyName, error: error.message });
      throw error;
    }
  }

  /**
   * Clean up resources on managed cluster
   * This is optional - ACM should handle cleanup via prune
   * @param {string} policyName
   */
  async cleanupManagedClusterResources(policyName) {
    try {
      logger.info('Policy cleanup handled by ACM prune:', { policyName });
      // ACM's ConfigurationPolicy with prune: true should handle deletion
      // Explicit deletion would require placing a different policy)
    } catch (error) {
      logger.warn('Cleanup warning:', { policyName, error: error.message });
    }
  }

  /**
   * Sync all events from database to ACM policies
   * Call this on startup to ensure all events have corresponding policies
   * @param {Array} events - All events from database
   * @returns {Object} Summary of sync results
   */
  async syncAllPolicies(events) {
    const results = {
      total: events.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: []
    };

    for (const event of events) {
      try {
        if (event.policy_status === 'deleted') {
          results.skipped++;
          continue;
        }

        if (!event.policy_name || event.policy_status === 'pending') {
          // Create new policy
          const result = await this.createUpgradePolicy(event);
          if (result.action === 'created') {
            results.created++;
          } else {
            results.updated++;
          }
        } else {
          // Policy already exists, verify it's up to date
          try {
            const result = await this.createUpgradePolicy(event);
            if (result.action === 'updated') {
              results.updated++;
            } else {
              results.skipped++;
            }
          } catch (error) {
            results.errors.push({ eventId: event.id, error: error.message });
          }
        }
      } catch (error) {
        results.errors.push({ eventId: event.id, error: error.message });
      }
    }

    logger.info('Policy sync complete:', results);
    return results;
  }
}

export const policyService = new PolicyService();
export default policyService;