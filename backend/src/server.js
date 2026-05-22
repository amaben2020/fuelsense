require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./database');
const { startTcpServer } = require('./tcp-server');

const authRoutes = require('./routes/auth');
const vehicleRoutes = require('./routes/vehicles');
const deviceRoutes = require('./routes/devices');
const telemetryRoutes = require('./routes/telemetry');
const alertRoutes = require('./routes/alerts');
const orderRoutes = require('./routes/orders');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/orders', orderRoutes);

const start = async () => {
  await initDatabase();
  await startTcpServer();

  const port = Number(process.env.PORT || 5001);
  app.listen(port, () => {
    console.log(`Express server running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/api/health`);
  });
};

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
