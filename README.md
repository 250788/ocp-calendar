# OpenShift Cluster Upgrade Scheduler

A lightweight frontend calendar application with Node.js backend that schedules OpenShift cluster upgrades via ACM (Advanced Cluster Management) policies containing CronJobs.

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   Frontend      │──────►  Backend API    │──────►   ACM Hub      │
│  (FullCalendar) │      │  (Node.js)       │      │   Cluster       │
└─────────────────┘      └──────────────────┘      └─────────────────┘
                                                        │
                                                        ▼
                                              ┌─────────────────────┐
                                              │ Managed Cluster     │
                                              │ (CronJob executes   │
                                              │  OpenShift upgrade) │
                                              └─────────────────────┘
```

## Features

- **Interactive Calendar UI**: Add, view, and manage upgrade schedules with FullCalendar
- **Automated ACM Policy Generation**: Creates ACM policies with embedded CronJobs for scheduled upgrades
- **Cluster Targeting**: Assign upgrades to specific managed clusters registered in ACM
- **Maintenance Windows**: Schedule upgrades at specific times with configurable durations
- **Policy Enforcement**: ACM enforces CronJob creation on target managed clusters
- **Real-time Status**: Track policy creation status and event scheduling state
- **Multi-version Support**: Schedule upgrades to any OpenShift 4.x version

## Prerequisites

- **OpenShift Cluster** with ACM (Advanced Cluster Management) installed and configured
- **Managed Clusters** registered with the ACM hub cluster
- **Node.js 20+** for backend development
- **Docker** and **OpenShift CLI (oc)** for deployment
- **Image Registry** accessible from the OpenShift cluster
- kubectl/oc configured with cluster-admin access to the ACM hub cluster

## Project Structure

```
clusters-upgrade-calendar/
├── frontend/
│   ├── index.html          # Main HTML page
│   ├── styles.css          # Styling
│   ├── app.js              # Frontend JavaScript with FullCalendar
│   ├── package.json        # Frontend dependencies
│   └── Dockerfile          # Frontend container image
├── backend/
│   ├── src/
│   │   ├── index.js        # Main Express server
│   │   ├── routes/
│   │   │   ├── events.js   # Event CRUD API endpoints
│   │   │   └── health.js   # Health check endpoints
│   │   ├── services/
│   │   │   ├── eventService.js   # Event business logic
│   │   │   └── policyService.js  # ACM policy generation
│   │   ├── models/
│   │   │   └── event.js    # SQLite database model
│   │   └── lib/
│   │       └── acmClient.js # Kubernetes/ACM API client
│   ├── openshift-manifests/
│   │   ├── 00-serviceaccount.yaml  # SA and RBAC
│   │   ├── 01-configmap.yaml       # Application config
│   │   ├── 02-deployment.yaml      # Backend deployment + PVC
│   │   ├── 03-service.yaml         # Service
│   │   └── 04-route.yaml           # Route
│   ├── package.json        # Backend dependencies
│   └── Dockerfile          # Backend container image
└── README.md               # This file
```

## Quick Start

### 1. Build and Push Images

```bash
# Build backend image
cd backend
docker build -t registry.example.com/cluster-upgrade-calendar-backend:latest .

# Build frontend image
cd ../frontend
docker build -t registry.example.com/cluster-upgrade-calendar-frontend:latest .

# Push to registry
docker push registry.example.com/cluster-upgrade-calendar-backend:latest
docker push registry.example.com/cluster-upgrade-calendar-frontend:latest
```

Replace `registry.example.com` with your actual image registry.

### 2. Deploy to OpenShift

```bash
# Deploy to ACM hub cluster (or the cluster where backend will run)
cd backend/openshift-manifests

# Apply all manifests in order
oc apply -f 00-serviceaccount.yaml
oc apply -f 01-configmap.yaml
# Update image tags in deployment before applying
oc apply -f 02-deployment.yaml
oc apply -f 03-service.yaml
oc apply -f 04-route.yaml
```

**Important**: Before applying `02-deployment.yaml`, update the `image` field to match your pushed image:
```yaml
image: registry.example.com/cluster-upgrade-calendar-backend:latest
```

### 3. Access the Application

```bash
# Get the route URL
oc get route cluster-upgrade-calendar-backend -n open-cluster-management
```

Open the URL in your browser to access the calendar UI.

## Configuration

### Backend Environment Variables

Configure via ConfigMap (`01-configmap.yaml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | production | Application environment |
| `PORT` | 3000 | HTTP server port |
| `LOG_LEVEL` | info | Logging level (debug, info, warn, error) |
| `POLICY_NAMESPACE` | open-cluster-management | Namespace for ACM policies |
| `CRONJOB_NAMESPACE` | openshift-upgrade | Namespace where CronJobs run on managed clusters |
| `DB_PATH` | /data/events.db | SQLite database path (in-container) |
| `FRONTEND_URL` | * | CORS allowed origin |

### ACM ServiceAccount Permissions

The `cluster-upgrade-calendar` ServiceAccount has the following permissions:

- Read/write access to ACM policies (`policy.open-cluster-management.io`)
- Read access to managed clusters (`cluster.open-cluster-management.io`)
- Read access to Kubernetes namespaces, service accounts, and pods
- API discovery access

These are defined in the `ClusterRole` in `00-serviceaccount.yaml`.

**Security Note**: The backend uses the in-cluster ServiceAccount token, so no explicit credentials are stored.

## How It Works

### 1. User Creates Event

User opens the frontend calendar, clicks on a date, fills in the upgrade form:

- **Title**: Descriptive name for the upgrade
- **Cluster**: Name of the managed cluster (must match ACM registration)
- **Date**: When to perform the upgrade
- **Time**: Start time (maintenance window start)
- **Duration**: Expected upgrade duration in minutes
- **OpenShift Version**: Target version to upgrade to (e.g., 4.14.0)
- **Notes**: Optional details, prerequisites, rollback plan

### 2. Backend Processes Event

1. Validates event data
2. Stores event in SQLite database
3. Generates an ACM Policy containing:
   - **ConfigurationPolicy** with a CronJob template
   - **ServiceAccount** for the CronJob to run with
   - **Placement Rule** targeting the specified managed cluster
4. Creates the policy in the ACM hub cluster

### 3. ACM Enforces Policy

ACM hub cluster evaluates the policy and places it on the target managed cluster. The policy is in `enforce` mode, so ACM ensures the CronJob exists on the managed cluster.

### 4. CronJob Executes

On the scheduled date and time, the CronJob runs on the managed cluster:

1. Pod starts with `ose-cli` image (includes `oc` command)
2. Executes: `oc upgrade --to=<target-version> --verify=health`
3. Performs the OpenShift cluster upgrade
4. Reports success/failure in job history

### 5. Event Lifecycle

- **Delete Event**: Removes database record and deletes ACM policy
- **Resync**: Recreates policy if missing (useful after outages)

## API Reference

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/events` | List all upgrade events |
| `GET` | `/api/events/:id` | Get specific event |
| `POST` | `/api/events` | Create new upgrade event |
| `DELETE` | `/api/events/:id` | Delete event and cleanup |
| `POST` | `/api/events/:id/resync` | Recreate policy for event |
| `GET` | `/api/events/cluster/:name` | Get events for a cluster |
| `GET` | `/api/events/date/:date` | Get events for a date |
| `POST` | `/api/events/sync-all` | Sync all events with ACM |

### Example Request

```bash
curl -X POST http://backend:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Production Cluster Upgrade",
    "cluster_name": "prod-cluster-1",
    "scheduled_date": "2025-12-15",
    "start_time": "02:00",
    "duration_minutes": 180,
    "openshift_version": "4.15.0",
    "notes": "Verify backups before maintenance window"
  }'
```

## Development

### Run Backend Locally

```bash
cd backend
npm install
npm run dev
```

For local development, the backend can use your local `~/.kube/config` if in-cluster config is unavailable.

### Run Frontend Locally

```bash
cd frontend
npx serve .
```

Or simply open `index.html` in a browser (API calls will need a proxy or CORS-enabled backend).

### Testing

1. Start backend locally: `npm run dev` (port 3000)
2. Open frontend and configure API base URL to `http://localhost:3000`
3. Create test events with non-production clusters
4. Verify policies appear in ACM: `oc get policies -n open-cluster-management`

## ACM Policy Structure

The backend generates ACM policies in this format:

```yaml
apiVersion: policy.open-cluster-management.io/v1
kind: Policy
metadata:
  name: upgrade-policy-cluster1-abc12345
  namespace: open-cluster-management
  labels:
    app.kubernetes.io/created-by: cluster-upgrade-calendar
    cluster-name: cluster1
    upgrade-event-id: <uuid>
spec:
  disabled: false
  remediationAction: enforce
  placement:
    name: placement-cluster1
    clusterSelector:
      matchLabels:
        name: cluster1
        vendor: OpenShift
  policy-templates:
  - objectDefinition:
      apiVersion: policy.open-cluster-management.io/v1
      kind: ConfigurationPolicy
      metadata:
        name: upgrade-cronjob
      spec:
        remediationAction: enforce
        prune: true
        object-templates:
        - complianceType: musthave
          objectDefinition:
            apiVersion: batch/v1
            kind: CronJob
            metadata:
              name: openshift-upgrade-cluster1-ab12
              namespace: openshift-upgrade
              labels:
                upgrade-event-id: <uuid>
            spec:
              schedule: "0 2 15 12 *"
              concurrencyPolicy: Forbid
              jobTemplate:
                spec:
                  serviceAccountName: openshift-upgrade-cluster1-ab12
                  template:
                    spec:
                      restartPolicy: OnFailure
                      containers:
                      - name: openshift-upgrade
                        image: registry.redhat.io/openshift4/ose-cli:latest
                        command: ["/bin/bash", "-c"]
                        args:
                        - |
                          oc upgrade --to=4.15.0 -- stabilization-timeout=20m --verify=health
```

### Managed Cluster Requirements

For the CronJob to work on managed clusters:

1. **OpenShift CLI**: The `ose-cli` image must be accessible from managed cluster (pull secret)
2. **ServiceAccount Permissions**: The service account needs permissions to run upgrades
3. **Pull Secret**: Managed cluster must have access to `registry.redhat.io`

Create a ServiceAccount with cluster-admin role on managed clusters:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: openshift-upgrade
  namespace: openshift-upgrade
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: openshift-upgrade-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: openshift-upgrade
  namespace: openshift-upgrade
```

This ServiceAccount will be created automatically by the ACM policy.

## Troubleshooting

### Backend Cannot Connect to ACM

**Symptoms**: Health check fails, policies not created.

**Check**:
```bash
oc logs deployment/cluster-upgrade-calendar-backend -n open-cluster-management
```

Ensure the pod has the ServiceAccount mounted and can reach the API server.

**Verify SA token**:
```bash
oc exec deployment/cluster-upgrade-calendar-backend -n open-cluster-management -- \
  cat /var/run/secrets/kubernetes.io/serviceaccount/token
```

### Policies Not Enforced on Managed Clusters

**Check**:
```bash
# List policies in hub
oc get policies -n open-cluster-management -l app.kubernetes.io/created-by=cluster-upgrade-calendar

# Check policy compliance on managed cluster
oc get configurationpolicy -n openshift-upgrade -o wide
```

Verify the managed cluster is properly registered with ACM and the placement rule matches.

### CronJob Not Running

**Check on managed cluster**:
```bash
# Get managed cluster kubeconfig
oc get managedcluster <cluster-name> -o jsonpath='{.status.conditions[?(@.type=="HubAcceptedManagedCluster")].status}'

# Check CronJob exists
oc get cronjob -n openshift-upgrade

# Check job history
oc get jobs -n openshift-upgrade
oc logs job/<cronjob-name>-<timestamp> -n openshift-upgrade
```

### Frontend Not Loading

Check the Route is accessible:
```bash
oc get route cluster-upgrade-calendar-backend -n open-cluster-management
```

Verify frontend pod/deployment status if using separate frontend deployment.

## Security Considerations

1. **Authentication**: Backend uses in-cluster SA token; frontend currently has no authentication
2. **Authorization**: SA permissions limited to ACM policy management and read-only cluster info
3. **Input Validation**: Event data is validated; cluster names are sanitized
4. **Network**: Backend only needs access to Kubernetes API; consider network policies
5. **Upgrade Operations**: CronJob uses OpenShift CLI with cluster-admin equivalent; ensure only trusted users can create events

### Hardening Recommendations

- Add frontend authentication (OAuth, SSO)
- Implement RBAC for different user roles
- Add audit logging for event creation/deletion
- Review and customize ServiceAccount permissions
- Use separate ServiceAccount for upgrades with minimal permissions

## Production Deployment

### Persistent Storage

The SQLite database is stored in `/data/events.db` with a PersistentVolumeClaim. Ensure:

```bash
oc get pvc cluster-upgrade-calendar-data -n open-cluster-management
```

Monitoring PVC capacity and configuring backups if needed.

### Monitoring

Add Prometheus metrics endpoint to backend and scrape with OpenShift monitoring.

### High Availability

- Backend is deployed as single replica; scale to multiple replicas if needed
- SQLite is not suited for multi-replica write access; consider PostgreSQL for HA
- Add leader election if scaling beyond 1 replica

### Backup/Restore

Backup the SQLite database:

```bash
oc exec deployment/cluster-upgrade-calendar-backend -n open-cluster-management -- \
  tar czf /tmp/events-backup.tar.gz /data/events.db
# Copy file from pod
```

Restore by replacing the PVC data or mounting backup to `/data/events.db`.

## Upgrading the Application

1. Build and push new images
2. Update image tags in `02-deployment.yaml`
3. Apply manifests: `oc apply -f openshift-manifests/`
4. Rolling update will occur automatically

## License

MIT

## Support

For issues, questions, or contributions, please open an issue in the project repository.