import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import EventModel from '../models/event.js';
import policyService from '../services/policyService.js';
import acmClient from '../lib/acmClient.js';
import winston from 'winston';

const router = express.Router();
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
});

/**
 * GET /api/events
 * List all scheduled upgrade events
 */
router.get('/', async (req, res) => {
  try {
    const events = EventModel.getAll();
    res.json({
      success: true,
      count: events.length,
      data: events
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch events',
      message: error.message
    });
  }
});

/**
 * GET /api/events/:id
 * Get a specific event
 */
router.get('/:id', async (req, res) => {
  try {
    const event = EventModel.getById(req.params.id);
    if (!event) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }
    res.json({
      success: true,
      data: event
    });
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch event',
      message: error.message
    });
  }
});

/**
 * POST /api/events
 * Create a new upgrade event and generate ACM policy
 */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      cluster_name: clusterName,
      scheduled_date: scheduledDate,
      start_time: startTime,
      duration_minutes: durationMinutes = 60,
      openshift_version: openshiftVersion,
      notes
    } = req.body;

    // Validate required fields
    if (!title || !clusterName || !scheduledDate || !startTime || !openshiftVersion) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: title, cluster_name, scheduled_date, start_time, openshift_version'
      });
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(scheduledDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date format. Use YYYY-MM-DD'
      });
    }

    // Validate time format (HH:MM)
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(startTime)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid time format. Use HH:MM (24-hour format)'
      });
    }

    // Validate duration
    if (durationMinutes < 15 || durationMinutes > 480) {
      return res.status(400).json({
        success: false,
        error: 'Duration must be between 15 and 480 minutes'
      });
    }

    // Generate event ID
    const eventId = uuidv4();

    // Create event record
    EventModel.create({
      id: eventId,
      title: title.trim(),
      cluster_name: clusterName.trim(),
      scheduled_date: scheduledDate,
      start_time: startTime,
      duration_minutes: durationMinutes,
      openshift_version: openshiftVersion.trim(),
      notes: notes?.trim() || null,
      policy_status: 'pending'
    });

    const event = EventModel.getById(eventId);

    try {
      // Generate and create ACM policy
      const policyResult = await policyService.createUpgradePolicy(event);

      // Update event with policy name
      EventModel.updatePolicyStatus(eventId, 'created', policyResult.name);

      logger.info('Event created with policy:', {
        eventId,
        policyName: policyResult.name
      });

      res.status(201).json({
        success: true,
        message: 'Event created and ACM policy generated',
        data: {
          event: EventModel.getById(eventId),
          policy: policyResult
        }
      });
    } catch (policyError) {
      // Policy creation failed, but event is saved
      logger.error('Policy creation failed, event saved:', {
        eventId,
        error: policyError.message
      });

      res.status(201).json({
        success: true,
        message: 'Event created but ACM policy generation failed',
        warning: policyError.message,
        data: EventModel.getById(eventId)
      });
    }
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create event',
      message: error.message
    });
  }
});

/**
 * DELETE /api/events/:id
 * Cancel an upgrade event and delete associated ACM policy
 */
router.delete('/:id', async (req, res) => {
  try {
    const event = EventModel.getById(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }

    // Delete ACM policy if one was created
    if (event.policy_name) {
      try {
        await policyService.deleteUpgradePolicy(event.policy_name);
        logger.info('Policy deleted for event:', { eventId: req.params.id });
      } catch (policyError) {
        logger.error('Failed to delete policy:', {
          eventId: req.params.id,
          policyName: event.policy_name,
          error: policyError.message
        });
        // Continue with event deletion even if policy deletion fails
      }
    }

    // Delete event record
    EventModel.delete(req.params.id);

    res.json({
      success: true,
      message: 'Event cancelled and policy deleted (if existed)',
      data: { eventId: req.params.id }
    });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete event',
      message: error.message
    });
  }
});

/**
 * POST /api/events/:id/resync
 * Resync event with ACM (recreate policy if missing)
 */
router.post('/:id/resync', async (req, res) => {
  try {
    const event = EventModel.getById(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }

    if (event.policy_status === 'deleted') {
      return res.status(400).json({
        success: false,
        error: 'Cannot resync deleted event'
      });
    }

    try {
      const policyResult = await policyService.createUpgradePolicy(event);

      res.json({
        success: true,
        message: 'Policy resynced successfully',
        data: {
          event: EventModel.getById(req.params.id),
          policy: policyResult
        }
      });
    } catch (policyError) {
      res.status(500).json({
        success: false,
        error: 'Failed to resync policy',
        message: policyError.message
      });
    }
  } catch (error) {
    console.error('Error resyncing event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resync event',
      message: error.message
    });
  }
});

/**
 * GET /api/events/cluster/:clusterName
 * Get all events for a specific cluster
 */
router.get('/cluster/:clusterName', async (req, res) => {
  try {
    const events = EventModel.getByCluster(req.params.clusterName);
    res.json({
      success: true,
      count: events.length,
      data: events
    });
  } catch (error) {
    console.error('Error fetching cluster events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cluster events',
      message: error.message
    });
  }
});

/**
 * GET /api/events/date/:date
 * Get all events for a specific date (YYYY-MM-DD)
 */
router.get('/date/:date', async (req, res) => {
  try {
    const events = EventModel.getByDate(req.params.date);
    res.json({
      success: true,
      count: events.length,
      data: events
    });
  } catch (error) {
    console.error('Error fetching date events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch date events',
      message: error.message
    });
  }
});

/**
 * POST /api/events/sync-all
 * Sync all events with ACM (useful on startup)
 */
router.post('/sync-all', async (req, res) => {
  try {
    const events = EventModel.getAll();
    const results = await policyService.syncAllPolicies(events);

    res.json({
      success: true,
      message: 'Sync complete',
      data: results
    });
  } catch (error) {
    console.error('Error syncing all events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync events',
      message: error.message
    });
  }
});

export default router;