import fs from 'fs';
import https from 'https';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

/**
 * Lightweight Kubernetes/ACM client using raw HTTPS calls.
 * Avoids @kubernetes/client-node version incompatibilities.
 * Reads the in-cluster service account token directly.
 */

// In-cluster config paths
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const SA_NS_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

class KubernetesError extends Error {
  constructor(statusCode, message, body) {
    super(`${statusCode}: ${message}`);
    this.statusCode = statusCode;
    this.body = body;
    this.name = 'KubernetesError';
  }
}

export class ACMClient {
  constructor() {
    this.apiUrl = null;
    this.token = null;
    this.ca = null;
    this.namespace = null;
    this.initialized = false;
  }

  /**
   * Initialize client from in-cluster service account credentials
   */
  async initialize() {
    // Read token
    this.token = fs.readFileSync(SA_TOKEN_PATH, 'utf8');

    // Read CA cert
    try {
      this.ca = fs.readFileSync(SA_CA_PATH, 'utf8');
    } catch {
      this.ca = false; // skip TLS verification if CA not available
    }

    // Read namespace
    try {
      this.namespace = fs.readFileSync(SA_NS_PATH, 'utf8').trim();
    } catch {
      this.namespace = process.env.POLICY_NAMESPACE || 'openshift-gitops';
    }

    // Build API URL from environment or default
    const host = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    this.apiUrl = `https://${host}:${port}`;

    this.initialized = true;
    logger.info('ACM Client initialized (raw HTTPS)', { namespace: this.namespace });
  }

  async ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Make an HTTP request to the Kubernetes API
   */
  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.apiUrl);
      const options = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        rejectUnauthorized: this.ca !== false,
      };

      if (this.ca) {
        options.ca = this.ca;
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              const message = parsed.message || parsed.reason || res.statusMessage;
              reject(new KubernetesError(res.statusCode, message, parsed));
            } else {
              resolve({ body: parsed, statusCode: res.statusCode });
            }
          } catch (e) {
            if (res.statusCode >= 400) {
              reject(new KubernetesError(res.statusCode, res.statusMessage, data));
            } else {
              resolve({ body: data, statusCode: res.statusCode });
            }
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Health check — hit the version endpoint
   */
  async healthCheck() {
    try {
      await this.ensureInitialized();
      const res = await this._request('GET', '/version');
      return { healthy: true, version: res.body };
    } catch (error) {
      logger.error('Health check failed:', error.message);
      return { healthy: false, error: error.message };
    }
  }

  /**
   * Create an ACM Policy along with PlacementRule and PlacementBinding
   */
  async createPolicy(policy, namespace = null) {
    const ns = namespace || this.namespace;
    await this.ensureInitialized();

    const policyBody = {
      apiVersion: 'policy.open-cluster-management.io/v1',
      kind: 'Policy',
      metadata: {
        name: policy.metadataName,
        namespace: ns,
        labels: policy.labels || {}
      },
      spec: {
        disabled: false,
        remediationAction: 'enforce',
        'policy-templates': policy.policyTemplates
      }
    };

    logger.info('Creating ACM Policy:', {
      name: policy.metadataName,
      namespace: ns,
      cluster: policy.targetCluster
    });

    const res = await this._request(
      'POST',
      `/apis/policy.open-cluster-management.io/v1/namespaces/${ns}/policies`,
      policyBody
    );

    logger.info('Policy created successfully:', {
      name: policy.metadataName,
      uid: res.body.metadata.uid
    });

    // Create PlacementRule
    if (policy.placementRuleName && policy.targetCluster) {
      const placementRuleBody = {
        apiVersion: 'apps.open-cluster-management.io/v1',
        kind: 'PlacementRule',
        metadata: {
          name: policy.placementRuleName,
          namespace: ns,
          labels: policy.labels || {}
        },
        spec: {
          clusterConditions: [{ type: 'ManagedClusterConditionAvailable', status: 'True' }],
          clusterSelector: {
            matchExpressions: [
              { key: 'name', operator: 'In', values: [policy.targetCluster] }
            ]
          }
        }
      };

      await this._request(
        'POST',
        `/apis/apps.open-cluster-management.io/v1/namespaces/${ns}/placementrules`,
        placementRuleBody
      );
      logger.info('PlacementRule created:', { name: policy.placementRuleName });
    }

    // Create PlacementBinding
    if (policy.placementBindingName && policy.placementRuleName) {
      const placementBindingBody = {
        apiVersion: 'policy.open-cluster-management.io/v1',
        kind: 'PlacementBinding',
        metadata: {
          name: policy.placementBindingName,
          namespace: ns,
          labels: policy.labels || {}
        },
        placementRef: {
          name: policy.placementRuleName,
          kind: 'PlacementRule',
          apiGroup: 'apps.open-cluster-management.io'
        },
        subjects: [
          {
            name: policy.metadataName,
            kind: 'Policy',
            apiGroup: 'policy.open-cluster-management.io'
          }
        ]
      };

      await this._request(
        'POST',
        `/apis/policy.open-cluster-management.io/v1/namespaces/${ns}/placementbindings`,
        placementBindingBody
      );
      logger.info('PlacementBinding created:', { name: policy.placementBindingName });
    }

    return {
      success: true,
      name: policy.metadataName,
      namespace: ns,
      uid: res.body.metadata.uid
    };
  }

  /**
   * Update an existing ACM Policy
   */
  async updatePolicy(name, policy, namespace = null) {
    const ns = namespace || this.namespace;
    await this.ensureInitialized();

    const body = {
      apiVersion: 'policy.open-cluster-management.io/v1',
      kind: 'Policy',
      metadata: {
        name,
        namespace: ns,
        labels: policy.labels || {}
      },
      spec: {
        disabled: false,
        remediationAction: 'enforce',
        'policy-templates': policy.policyTemplates
      }
    };

    logger.info('Updating ACM Policy:', { name, namespace: ns });

    const res = await this._request(
      'PUT',
      `/apis/policy.open-cluster-management.io/v1/namespaces/${ns}/policies/${name}`,
      body
    );

    logger.info('Policy updated successfully:', { name, uid: res.body.metadata.uid });

    return { success: true, name, uid: res.body.metadata.uid };
  }

  /**
   * Delete an ACM Policy and its companions
   */
  async deletePolicy(name, namespace = null) {
    const ns = namespace || this.namespace;
    await this.ensureInitialized();

    logger.info('Deleting ACM Policy:', { name, namespace: ns });

    try {
      await this._request(
        'DELETE',
        `/apis/policy.open-cluster-management.io/v1/namespaces/${ns}/policies/${name}`
      );
      logger.info('Policy deleted successfully:', { name });
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      logger.warn('Policy not found, assuming deleted:', { name });
      return { success: true };
    }

    // Derive companion names
    const suffix = name.replace(/^upgrade-policy-/, '');
    const placementRuleName = `placement-${suffix}`;
    const placementBindingName = `binding-${suffix}`;

    // Delete PlacementBinding (best effort)
    try {
      await this._request(
        'DELETE',
        `/apis/policy.open-cluster-management.io/v1/namespaces/${ns}/placementbindings/${placementBindingName}`
      );
      logger.info('PlacementBinding deleted:', { name: placementBindingName });
    } catch (err) {
      if (err.statusCode !== 404) {
        logger.warn('Could not delete PlacementBinding:', { name: placementBindingName });
      }
    }

    // Delete PlacementRule (best effort)
    try {
      await this._request(
        'DELETE',
        `/apis/apps.open-cluster-management.io/v1/namespaces/${ns}/placementrules/${placementRuleName}`
      );
      logger.info('PlacementRule deleted:', { name: placementRuleName });
    } catch (err) {
      if (err.statusCode !== 404) {
        logger.warn('Could not delete PlacementRule:', { name: placementRuleName });
      }
    }

    return { success: true };
  }

  /**
   * Get an ACM Policy
   */
  async getPolicy(name, namespace = null) {
    const ns = namespace || this.namespace;
    await this.ensureInitialized();

    try {
      const res = await this._request(
        'GET',
        `/apis/policy.open-cluster-management.io/v1/namespaces/${ns}/policies/${name}`
      );
      return res.body;
    } catch (error) {
      if (error.statusCode === 404) return null;
      logger.error('Failed to get policy:', error.message);
      throw error;
    }
  }

  /**
   * List all policies with our label selector
   */
  async listUpgradePolicies(namespace = null) {
    const ns = namespace || this.namespace;
    await this.ensureInitialized();

    try {
      const res = await this._request(
        'GET',
        `/apis/policy.open-cluster-management.io/v1/namespaces/${ns}/policies?labelSelector=app.kubernetes.io%2Fcreated-by%3Dcluster-upgrade-calendar`
      );
      return res.body.items || [];
    } catch (error) {
      logger.error('Failed to list policies:', error.message);
      return [];
    }
  }
}

// Singleton instance
export const acmClient = new ACMClient();

export default acmClient;
