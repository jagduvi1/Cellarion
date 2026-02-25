const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const healthRoute = require('./routes/health');
const authRoute = require('./routes/auth');
const usersRoute = require('./routes/users');
const winesRoute = require('./routes/wines');
const cellarsRoute = require('./routes/cellars');
const bottlesRoute = require('./routes/bottles');
const wineRequestsRoute = require('./routes/wineRequests');
const adminTaxonomyRoute = require('./routes/admin/taxonomy');
const adminWinesRoute = require('./routes/admin/wines');
const adminWineRequestsRoute = require('./routes/admin/wineRequests');
const adminImagesRoute = require('./routes/admin/images');
const adminAuditRoute = require('./routes/admin/audit');
const adminUsersRoute = require('./routes/admin/users');
const racksRoute = require('./routes/racks');
const imagesRoute = require('./routes/images');
const sommMaturityRoute = require('./routes/somm/maturity');
const sommPricesRoute  = require('./routes/somm/prices');

const app = express();

// Security headers
app.use(helmet());

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Serve uploaded images (restricted to image file extensions only)
app.use('/api/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
  if (!allowedExts.includes(ext)) {
    return res.status(403).json({ error: 'File type not allowed' });
  }
  next();
}, express.static('/app/uploads'));

// Routes
app.use('/api/health', healthRoute);
app.use('/api/auth', authRoute);
app.use('/api/users', usersRoute);
app.use('/api/wines', winesRoute);
app.use('/api/cellars', cellarsRoute);
app.use('/api/bottles', bottlesRoute);
app.use('/api/wine-requests', wineRequestsRoute);
app.use('/api/admin/taxonomy', adminTaxonomyRoute);
app.use('/api/admin/wines', adminWinesRoute);
app.use('/api/admin/wine-requests', adminWineRequestsRoute);
app.use('/api/admin/images', adminImagesRoute);
app.use('/api/admin/audit', adminAuditRoute);
app.use('/api/admin/users', adminUsersRoute);
app.use('/api/racks', racksRoute);
app.use('/api/images', imagesRoute);
app.use('/api/somm/maturity', sommMaturityRoute);
app.use('/api/somm/prices',  sommPricesRoute);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

module.exports = app;
