// server.js (CAP Custom Server Entry Point)
const cds = require('@sap/cds');
const cors = require('cors');

cds.on('bootstrap', (app) => {
    // Allow the local React frontend to call the CAP OData APIs
    app.use(cors({
        origin: 'http://localhost:5173',
        credentials: true
    }));
});

module.exports = cds.server;