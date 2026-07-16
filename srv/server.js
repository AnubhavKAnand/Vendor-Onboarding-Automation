const cds = require('@sap/cds');

cds.on('bootstrap', (app) => {
    const bodyParser = require('body-parser');
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
});

module.exports = cds.server;
