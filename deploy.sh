#!/bin/bash
#
# OpenShift Deployment Script for Cluster Upgrade Calendar
#
# Prerequisites:
#   - oc CLI installed and logged into the OpenShift cluster
#   - oc has cluster-admin permissions
#   - Docker/container images built and pushed to registry
#
# Usage:
#   ./deploy.sh [options]
#
# Options:
#   --registry REGISTRY        Container registry (default: docker.io/youruser)
#   --tag TAG                  Image tag (default: latest)
#   --namespace NAMESPACE      Target namespace (default: open-cluster-management)
#   --managed-cluster CLUSTER  Apply managed cluster RBAC to specific cluster
#   --dry-run                  Show what would be deployed without applying
#   --skip-images              Skip image pull/push (assume images already pushed)
#   --skip-backend             Skip backend deployment
#   --skip-managed-rbac        Skip managed cluster RBAC application
#

set -euo pipefail

# Default values
REGISTRY=""
TAG="latest"
NAMESPACE="open-cluster-management"
DRY_RUN=false
SKIP_IMAGES=false
SKIP_BACKEND=false
SKIP_MANAGED_RBAC=false
MANAGED_CLUSTER=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --registry)
      REGISTRY="$2"
      shift 2
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --managed-cluster)
      MANAGED_CLUSTER="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-images)
      SKIP_IMAGES=true
      shift
      ;;
    --skip-backend)
      SKIP_BACKEND=true
      shift
      ;;
    --skip-managed-rbac)
      SKIP_MANAGED_RBAC=true
      shift
      ;;
    --help)
      echo "Usage: $0 [options]"
      echo ""
      echo "Options:"
      echo "  --registry REGISTRY        Container registry (e.g., quay.io/myorg)"
      echo "  --tag TAG                 Image tag (default: latest)"
      echo "  --namespace NAMESPACE     Target namespace (default: open-cluster-management)"
      echo "  --managed-cluster CLUSTER Apply RBAC to specific managed cluster"
      echo "  --dry-run                 Show what would be deployed"
      echo "  --skip-images             Skip building/pushing images"
      echo "  --skip-backend            Skip backend deployment"
      echo "  --skip-managed-rbac       Skip managed cluster RBAC setup"
      echo "  --help                    Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check for oc CLI
if ! command -v oc &> /dev/null; then
  log_error "oc CLI not found. Please install oc and log in."
  exit 1
fi

# Check if logged in
if ! oc whoami &> /dev/null; then
  log_error "Not logged into OpenShift. Run: oc login"
  exit 1
fi

log_info "Starting deployment to namespace: $NAMESPACE"

# Step 1: Build and push images
if [ "$SKIP_IMAGES" = false ]; then
  log_info "Building Docker images..."

  if [ -z "$REGISTRY" ]; then
    log_warn "No registry specified. Using default: docker.io/$(oc whoami)"
    REGISTRY="docker.io/$(oc whoami)"
  fi

  BACKEND_IMAGE="${REGISTRY}/cluster-upgrade-calendar-backend:${TAG}"
  FRONTEND_IMAGE="${REGISTRY}/cluster-upgrade-calendar-frontend:${TAG}"

  # Build backend
  log_info "Building backend image: $BACKEND_IMAGE"
  cd backend
  docker build -t "$BACKEND_IMAGE" .
  cd ..

  # Build frontend
  log_info "Building frontend image: $FRONTEND_IMAGE"
  cd frontend
  docker build -t "$FRONTEND_IMAGE" .
  cd ..

  # Push images
  log_info "Pushing images to registry..."
  docker push "$BACKEND_IMAGE"
  docker push "$FRONTEND_IMAGE"

  log_success "Images built and pushed"
else
  log_info "Skipping image build/push (--skip-images)"
  if [ -z "$REGISTRY" ]; then
    log_error "Registry is required when using --skip-images to update deployment"
    exit 1
  fi
  BACKEND_IMAGE="${REGISTRY}/cluster-upgrade-calendar-backend:${TAG}"
  FRONTEND_IMAGE="${REGISTRY}/cluster-upgrade-calendar-frontend:${TAG}"
fi

# Step 2: Ensure namespace exists
if [ "$SKIP_BACKEND" = false ]; then
  log_info "Ensuring namespace exists: $NAMESPACE"
  if [ "$DRY_RUN" = true ]; then
    echo "  oc create namespace $NAMESPACE (dry run)"
  else
    oc create namespace "$NAMESPACE" --dry-run=client -o yaml | oc apply -f -
  fi

  # Step 3: Deploy backend
  log_info "Deploying backend..."

  # Update image in deployment manifest
  DEPLOYMENT_FILE="backend/openshift-manifests/02-deployment.yaml"
  if [ -f "$DEPLOYMENT_FILE" ]; then
    TEMP_DEPLOYMENT=$(mktemp)

    # Replace image placeholder if it exists, or add if not found
    sed "s|image: .*|image: $BACKEND_IMAGE|g" "$DEPLOYMENT_FILE" > "$TEMP_DEPLOYMENT"

    if [ "$DRY_RUN" = true ]; then
      echo "Would apply: oc apply -f backend/openshift-manifests/00-serviceaccount.yaml"
      echo "Would apply: oc apply -f backend/openshift-manifests/01-configmap.yaml"
      echo "Would apply updated deployment with image: $BACKEND_IMAGE"
      echo "Would apply: oc apply -f $TEMP_DEPLOYMENT"
      echo "Would apply: oc apply -f backend/openshift-manifests/03-service.yaml"
      echo "Would apply: oc apply -f backend/openshift-manifests/04-route.yaml"
    else
      # Apply manifests in order
      log_info "Applying ServiceAccount and RBAC..."
      oc apply -f backend/openshift-manifests/00-serviceaccount.yaml -n "$NAMESPACE"

      log_info "Applying ConfigMap..."
      oc apply -f backend/openshift-manifests/01-configmap.yaml -n "$NAMESPACE"

      log_info "Applying Deployment (image: $BACKEND_IMAGE)..."
      oc apply -f "$TEMP_DEPLOYMENT" -n "$NAMESPACE"

      log_info "Applying Service..."
      oc apply -f backend/openshift-manifests/03-service.yaml -n "$NAMESPACE"

      log_info "Applying Route..."
      oc apply -f backend/openshift-manifests/04-route.yaml -n "$NAMESPACE"

      log_success "Backend deployed"
    fi

    rm "$TEMP_DEPLOYMENT"
  else
    log_error "Deployment manifest not found: $DEPLOYMENT_FILE"
    exit 1
  fi

  # Wait for deployment to be ready
  if [ "$DRY_RUN" = false ]; then
    log_info "Waiting for backend deployment to be ready..."
    oc rollout status deployment/cluster-upgrade-calendar-backend -n "$NAMESPACE" --timeout=300s
  fi
fi

# Step 4: Apply managed cluster RBAC
if [ "$SKIP_MANAGED_RBAC" = false ]; then
  log_info "Managing managed cluster RBAC..."

  if [ -z "$MANAGED_CLUSTER" ]; then
    log_warn "No managed cluster specified. Skipping managed cluster RBAC."
    log_info "Apply manually to each managed cluster:"
    log_info "  oc apply -f backend/openshift-manifests/50-managed-cluster-rbac.yaml"
  else
    log_info "Applying RBAC to managed cluster: $MANAGED_CLUSTER"

    if [ "$DRY_RUN" = true ]; then
      echo "Would switch context to managed cluster: $MANAGED_CLUSTER"
      echo "Would apply: backend/openshift-manifests/50-managed-cluster-rbac.yaml"
    else
      # Switch to managed cluster context
      CURRENT_CONTEXT=$(oc config current-context)
      MANAGED_CONTEXT=""

      # Try to find managed cluster context
      for ctx in $(oc config get-contexts -o name); do
        if [[ "$ctx" == *"$MANAGED_CLUSTER"* ]] || [[ "$ctx" == "$MANAGED_CLUSTER" ]]; then
          MANAGED_CONTEXT="$ctx"
          break
        fi
      done

      if [ -z "$MANAGED_CONTEXT" ]; then
        log_error "Could not find context for managed cluster: $MANAGED_CLUSTER"
        log_info "You must manually switch to the managed cluster and apply the RBAC:"
        log_info "  oc apply -f backend/openshift-manifests/50-managed-cluster-rbac.yaml"
      else
        log_info "Switching to managed cluster context: $MANAGED_CONTEXT"
        oc config use-context "$MANAGED_CONTEXT"

        log_info "Applying RBAC manifest..."
        oc apply -f backend/openshift-manifests/50-managed-cluster-rbac.yaml

        # Switch back to original context
        oc config use-context "$CURRENT_CONTEXT"
        log_success "RBAC applied to managed cluster"
      fi
    fi
  fi
fi

# Summary
log_info "=========================================="
log_success "Deployment Summary"
log_info "=========================================="
log_info "Namespace: $NAMESPACE"
log_info "Backend Image: $BACKEND_IMAGE"
log_info "Frontend Image: $FRONTEND_IMAGE"

if [ -n "$MANAGED_CLUSTER" ] && [ "$SKIP_MANAGED_RBAC" = false ]; then
  log_info "Managed Cluster RBAC: Applied to $MANAGED_CLUSTER"
fi

log_info ""
log_info "Next steps:"
log_info "1. Get the backend route:"
log_info "   oc get route cluster-upgrade-calendar-backend -n $NAMESPACE"
log_info ""
log_info "2. Access the UI from the route URL"
log_info ""
log_info "3. For each managed cluster, ensure the openshift-upgrade SA exists:"
log_info "   oc apply -f backend/openshift-manifests/50-managed-cluster-rbac.yaml"
log_info ""
log_info "4. Start scheduling upgrade events via the UI!"
log_info "   Or via API: curl -X POST $API_BASE_URL/api/events ..."
log_info ""
log_info "Note: The frontend is served statically by nginx when the backend"
log_info "      is deployed with FRONTEND_BUILD_PATH configuration. For separate"
log_info "      frontend deployment, deploy the frontend image to OpenShift separately."

if [ "$DRY_RUN" = true ]; then
  log_warn "This was a dry run. No resources were actually deployed."
fi