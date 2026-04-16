// Initialization for Event Model

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DATABASE_FILE = path.join(__dirname, '..', '..', 'db', 'events.db');

// Initialize the database with error handling
const db = new sqlite3.Database(DATABASE_FILE, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the events database.');
        db.exec("PRAGMA journal_mode=WAL;", (err) => {
            if (err) {
                console.error('Error setting WAL mode:', err.message);
            }
        });
    }
});

module.exports = db;