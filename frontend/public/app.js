/**
 * OpenShift Cluster Upgrade Calendar
 * Frontend application with FullCalendar integration
 */

// Configuration - adjust API base URL as needed
const API_BASE_URL = window.location.origin.includes('localhost')
  ? 'http://localhost:3000'
  : '/';

// State
let selectedEvent = null;
let calendar = null;

// Axios instance with default config
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// DOM Elements
const elements = {
  calendar: document.getElementById('calendar'),
  addEventBtn: document.getElementById('add-event-btn'),
  eventModal: document.getElementById('event-modal'),
  closeModal: document.getElementById('close-modal'),
  eventForm: document.getElementById('event-form'),
  formError: document.getElementById('form-error'),
  formSuccess: document.getElementById('form-success'),
  cancelBtn: document.getElementById('cancel-btn'),
  viewButtons: document.querySelectorAll('.btn-view'),
  deleteModal: document.getElementById('delete-modal'),
  closeDeleteModal: document.getElementById('close-delete-modal'),
  cancelDeleteBtn: document.getElementById('cancel-delete-btn'),
  confirmDeleteBtn: document.getElementById('confirm-delete-btn'),
  detailsModal: document.getElementById('details-modal'),
  closeDetailsModal: document.getElementById('close-details-modal'),
  closeDetailsBtn: document.getElementById('close-details-btn'),
  deleteEventBtn: document.getElementById('delete-event-btn'),
  eventDetails: document.getElementById('event-details'),
  stats: {
    total: document.getElementById('total-events'),
    active: document.getElementById('active-policies'),
    pending: document.getElementById('pending-policies')
  },
  loadingOverlay: document.getElementById('loading-overlay')
};

// Debounce helper - prevents rapid repeated button clicks causing lag
let isFormSubmitting = false;
let isDeletingEvent = false;

// Initialize application
async function init() {
  console.log('Initializing application...');

  // Set default date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('scheduled-date').min = today;
  document.getElementById('scheduled-date').value = today;

  // Set default time to 2:00 AM (common maintenance window)
  document.getElementById('start-time').value = '02:00';

  // Initialize calendar
  initCalendar();

  // Load events
  await loadEvents();

  // Setup event listeners
  setupEventListeners();
}

// Initialize FullCalendar
function initCalendar() {
  const initialView = window.innerWidth < 768 ? 'dayGridMonth' : 'dayGridWeek';

  calendar = new FullCalendar.Calendar(elements.calendar, {
    initialView: initialView,
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,dayGridWeek,dayGridDay'
    },
    height: 'auto',
    aspectRatio: 2,
    editable: false,
    selectable: true,
    selectMirror: true,
    dayMaxEvents: true,
    weekends: true,
    eventDisplay: 'block',
    eventColor: '#0066cc',
    eventTextColor: 'white',
    eventDidMount: handleEventDidMount,
    select: handleDateSelect,
    eventClick: handleEventClick,
    datesSet: handleDatesSet
  });

  calendar.render();
}

// Event Did Mount - customize event appearance
function handleEventDidMount(info) {
  const event = info.event;
  const extendedProps = event.extendedProps;

  // Add cluster name as tooltip
  info.el.setAttribute('title', `${event.title}\n${extendedProps.clusterName || 'Unknown cluster'}`);

  // Add status indicator
  const statusClass = `status-${extendedProps.policyStatus || 'pending'}`;
  info.el.classList.add(statusClass);

  // Style based on policy status
  if (extendedProps.policyStatus === 'pending') {
    info.el.style.backgroundColor = '#ffc107';
    info.el.style.borderColor = '#e0a800';
  } else if (extendedProps.policyStatus === 'error') {
    info.el.style.backgroundColor = '#dc3545';
    info.el.style.borderColor = '#c82333';
  }
}

// Date select - pre-fill modal with selected date
function handleDateSelect(info) {
  const selectedDate = info.startStr;
  document.getElementById('scheduled-date').value = selectedDate;
  openModal('add');
}

// Event click - show details
function handleEventClick(info) {
  const event = info.event;
  selectedEvent = {
    id: event.id,
    ...event.extendedProps
  };
  showEventDetails(selectedEvent);
}

// Dates set - events are batch-loaded once, FullCalendar handles visible range filtering
function handleDatesSet() {
  // FullCalendar automatically filters batch-loaded events by visible date range
}

// Load events from API
async function loadEvents() {
  showLoadingOverlay(true);
  try {
    const response = await api.get('/api/events');
    const events = response.data.data || [];

    // Build validated event objects in memory first
    const calendarEvents = [];
    for (const event of events) {
      if (!event.id || !event.title || !event.scheduled_date || !event.start_time || event.duration_minutes == null) {
        console.warn('Skipping event due to missing required fields', event);
        continue;
      }

      // Use local Date objects for both start and end to avoid timezone mismatches
      const start = new Date(`${event.scheduled_date}T${event.start_time}`);
      if (isNaN(start.getTime())) {
        console.warn('Skipping event due to invalid start datetime', event);
        continue;
      }

      const end = new Date(start.getTime() + Number(event.duration_minutes) * 60000);

      calendarEvents.push({
        id: event.id,
        title: event.title,
        start: start,  // pass as Date object — FullCalendar handles timezone correctly
        end: end,
        extendedProps: {
          clusterName: event.cluster_name,
          openshiftVersion: event.openshift_version,
          durationMinutes: event.duration_minutes,
          notes: event.notes,
          policyName: event.policy_name,
          policyStatus: event.policy_status
        }
      });
    }

    console.log('Loading', calendarEvents.length, 'calendar events out of', events.length, 'DB events');

    // Clear all existing events and re-add the fresh set
    calendar.removeAllEvents();
    // Add events — FullCalendar v6 handles array input
    calendarEvents.forEach(ev => calendar.addEvent(ev));
    // Force re-render so events appear immediately after async load
    calendar.render();

    updateStats(events);
  } catch (error) {
    console.error('Failed to load events:', error);
    showError('Failed to load events. Please refresh the page.');
  } finally {
    showLoadingOverlay(false);
  }
}

// Loading overlay for async operations
function showLoadingOverlay(show) {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.style.display = show ? 'flex' : 'none';
  }
}

// Calculate end time with validation
function calculateEndTime(date, startTime, durationMinutes) {
  // Validate required parameters
  if (!date || !startTime || durationMinutes == null) {
    console.warn('calculateEndTime: missing parameters', {date, startTime, durationMinutes});
    return null;
  }

  // Normalize startTime to include seconds if needed (accept HH:MM or HH:MM:SS)
  let normalizedTime = startTime;
  if (startTime && startTime.split(':').length === 2) {
    normalizedTime = startTime + ':00';
  }

  const start = new Date(`${date}T${normalizedTime}`);
  if (isNaN(start.getTime())) {
    console.warn('calculateEndTime: invalid start datetime', {date, startTime, normalizedTime});
    return null;
  }

  const durationMs = Number(durationMinutes) * 60000;
  if (isNaN(durationMs) || durationMs <= 0) {
    console.warn('calculateEndTime: invalid duration', durationMinutes);
    return null;
  }

  const end = new Date(start.getTime() + durationMs);
  if (isNaN(end.getTime())) {
    console.warn('calculateEndTime: failed to compute end datetime');
    return null;
  }

  return end.toISOString();
}

// Update stats
function updateStats(events) {
  const total = events.length;
  const active = events.filter(e => e.policy_status === 'created').length;
  const pending = events.filter(e => e.policy_status === 'pending').length;

  elements.stats.total.textContent = total;
  elements.stats.active.textContent = active;
  elements.stats.pending.textContent = pending;
}

// Open modal
function openModal(mode, event = null) {
  selectedEvent = event;

  // Reset form
  elements.eventForm.reset();
  elements.formError.style.display = 'none';
  elements.formSuccess.style.display = 'none';

  if (mode === 'edit' && event) {
    document.getElementById('event-title').value = event.title;
    document.getElementById('cluster-name').value = event.clusterName;
    document.getElementById('scheduled-date').value = event.scheduled_date;
    document.getElementById('start-time').value = event.start_time;
    document.getElementById('duration-minutes').value = event.duration_minutes;
    document.getElementById('openshift-version').value = event.openshiftVersion;
    document.getElementById('notes').value = event.notes || '';
    document.getElementById('submit-btn-text').textContent = 'Update Upgrade';
  } else {
    document.getElementById('submit-btn-text').textContent = 'Schedule Upgrade';
  }

  elements.eventModal.classList.add('active');
}

// Close modal
function closeModal() {
  elements.eventModal.classList.remove('active');
  selectedEvent = null;
}

// Show event details
function showEventDetails(event) {
  const details = `
    <div class="detail-row">
      <span class="detail-label">Cluster:</span>
      <span class="detail-value">${escapeHtml(event.clusterName)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Date:</span>
      <span class="detail-value">${formatDate(event.scheduled_date)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Time:</span>
      <span class="detail-value">${event.start_time} (${event.duration_minutes} min)</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Target Version:</span>
      <span class="detail-value">OpenShift ${escapeHtml(event.openshiftVersion)}</span>
    </div>
    ${event.notes ? `
    <div class="detail-row">
      <span class="detail-label">Notes:</span>
      <span class="detail-value">${escapeHtml(event.notes)}</span>
    </div>
    ` : ''}
    <div class="detail-row">
      <span class="detail-label">Policy Status:</span>
      <span class="detail-value status-${event.policyStatus || 'pending'}">
        ${event.policyStatus || 'pending'}
        ${event.policyName ? `(${event.policyName.split('-').slice(0, 2).join('-')})` : ''}
      </span>
    </div>
  `;

  elements.eventDetails.innerHTML = details;
  elements.deleteEventBtn.dataset.eventId = event.id;
  elements.detailsModal.classList.add('active');
}

// Close details modal
function closeDetailsModal() {
  elements.detailsModal.classList.remove('active');
  selectedEvent = null;
}

// Show delete confirmation
function showDeleteConfirmation() {
  elements.deleteModal.classList.add('active');
}

// Hide delete confirmation
function hideDeleteConfirmation() {
  elements.deleteModal.classList.remove('active');
}

// Show error message
function showError(message) {
  elements.formError.textContent = message;
  elements.formError.style.display = 'block';
  elements.formSuccess.style.display = 'none';
}

// Show success message
function showSuccess(message) {
  elements.formSuccess.textContent = message;
  elements.formSuccess.style.display = 'block';
  elements.formError.style.display = 'none';
}

// Hide messages
function hideMessages() {
  elements.formError.style.display = 'none';
  elements.formSuccess.style.display = 'none';
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  if (!text) return ''; 
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Format date
function formatDate(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

// Setup event listeners
function setupEventListeners() {
  // Add event button
  elements.addEventBtn.addEventListener('click', () => openModal('add'));

  // Close buttons
  elements.closeModal.addEventListener('click', closeModal);
  elements.closeDeleteModal.addEventListener('click', hideDeleteConfirmation);
  elements.closeDetailsModal.addEventListener('click', closeDetailsModal);
  elements.closeDetailsBtn.addEventListener('click', closeDetailsModal);

  // Cancel buttons
  elements.cancelBtn.addEventListener('click', closeModal);
  elements.cancelDeleteBtn.addEventListener('click', hideDeleteConfirmation);

  // View switcher
  elements.viewButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      elements.viewButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      calendar.changeView(btn.dataset.view);
    });
  });

  // Form submission
  elements.eventForm.addEventListener('submit', handleFormSubmit);

  // Delete confirmation
  elements.confirmDeleteBtn.addEventListener('click', handleDeleteEvent);
  elements.deleteEventBtn.addEventListener('click', showDeleteConfirmation);

  // Click outside modal to close
  elements.eventModal.addEventListener('click', (e) => {
    if (e.target === elements.eventModal) closeModal();
  });
  elements.deleteModal.addEventListener('click', (e) => {
    if (e.target === elements.deleteModal) hideDeleteConfirmation();
  });
  elements.detailsModal.addEventListener('click', (e) => {
    if (e.target === elements.detailsModal) closeDetailsModal();
  });

  // Escape key to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      hideDeleteConfirmation();
      closeDetailsModal();
    }
  });
}

// Handle form submission
async function handleFormSubmit(e) {
  e.preventDefault();

  // Debounce: prevent double submissions
  if (isFormSubmitting) return;
  isFormSubmitting = true;

  hideMessages();

  const eventData = {
    title: document.getElementById('event-title').value.trim(),
    cluster_name: document.getElementById('cluster-name').value.trim(),
    scheduled_date: document.getElementById('scheduled-date').value,
    start_time: document.getElementById('start-time').value,
    duration_minutes: parseInt(document.getElementById('duration-minutes').value, 10),
    openshift_version: document.getElementById('openshift-version').value.trim(),
    notes: document.getElementById('notes').value.trim() || null
  };

  if (!eventData.title || !eventData.cluster_name || !eventData.scheduled_date ||
      !eventData.start_time || isNaN(eventData.duration_minutes) || !eventData.openshift_version) {
    showError('Please fill in all required fields.');
    isFormSubmitting = false;
    return;
  }

  try {
    if (selectedEvent) {
      await api.delete(`/api/events/${selectedEvent.id}`);
      const createResponse = await api.post('/api/events', eventData);
      showSuccess('Upgrade schedule updated successfully!');
    } else {
      const response = await api.post('/api/events', eventData);
      showSuccess('Upgrade scheduled successfully! ACM policy created.');
    }

    await loadEvents();
    closeModal();
  } catch (error) {
    console.error('Failed to save event:', error);
    const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
    showError(`Failed to schedule upgrade: ${errorMsg}`);
  } finally {
    isFormSubmitting = false;
  }
}

// Handle event deletion
async function handleDeleteEvent() {
  if (!selectedEvent || isDeletingEvent) return;
  isDeletingEvent = true;

  const eventId = selectedEvent.id;
  hideDeleteConfirmation();
  showLoadingOverlay(true);

  try {
    await api.delete(`/api/events/${eventId}`);

    // Remove from calendar
    calendar.getEventById(eventId)?.remove();

    // Update stats
    const events = calendar.getEvents();
    updateStats(events.map(e => ({
      id: e.id,
      policy_status: e.extendedProps.policyStatus
    })));

    closeDetailsModal();
    showSuccess('Upgrade cancelled and ACM policy deleted successfully.');
    
    // Reload events to ensure consistency
    setTimeout(loadEvents, 1500);
  } catch (error) {
    console.error('Failed to delete event:', error);
    const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
    showError(`Failed to cancel upgrade: ${errorMsg}`);
  } finally {
    isDeletingEvent = false;
    showLoadingOverlay(false);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { init, escapeHtml, formatDate };
}