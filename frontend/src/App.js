import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { ThemeProvider } from './contexts/ThemeContext';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import './styles/common.css';

// Lazy-load all pages so each route gets its own chunk.
// The initial bundle only includes Layout, ProtectedRoute, and routing logic.
const LandingPage     = lazy(() => import('./pages/LandingPage'));
const Login           = lazy(() => import('./pages/Login'));
const VerifyEmail     = lazy(() => import('./pages/VerifyEmail'));
const ResetPassword   = lazy(() => import('./pages/ResetPassword'));
const Cellars         = lazy(() => import('./pages/Cellars'));
const CellarDetail    = lazy(() => import('./pages/CellarDetail'));
const AddBottle       = lazy(() => import('./pages/AddBottle'));
const ImportBottles   = lazy(() => import('./pages/ImportBottles'));
const CellarRacks     = lazy(() => import('./pages/CellarRacks'));
const BottleDetail    = lazy(() => import('./pages/BottleDetail'));
const CellarHistory   = lazy(() => import('./pages/CellarHistory'));
const CellarAudit     = lazy(() => import('./pages/CellarAudit'));
const WineRequests    = lazy(() => import('./pages/WineRequests'));
const CellarChat      = lazy(() => import('./pages/CellarChat'));
const ReviewFeed      = lazy(() => import('./pages/ReviewFeed'));
const UserProfile     = lazy(() => import('./pages/UserProfile'));
const SommMaturity    = lazy(() => import('./pages/SommMaturity'));
const SommPrices      = lazy(() => import('./pages/SommPrices'));
const Settings        = lazy(() => import('./pages/Settings'));
const Plans           = lazy(() => import('./pages/Plans'));
const Statistics      = lazy(() => import('./pages/Statistics'));
const AdminWines      = lazy(() => import('./pages/AdminWines'));
const AdminRequests   = lazy(() => import('./pages/AdminRequests'));
const AdminTaxonomy   = lazy(() => import('./pages/AdminTaxonomy'));
const AdminImages     = lazy(() => import('./pages/AdminImages'));
const AdminSupportTickets = lazy(() => import('./pages/AdminSupportTickets'));
const AdminWineReports    = lazy(() => import('./pages/AdminWineReports'));
const SupportPage     = lazy(() => import('./pages/SupportPage'));
const SuperAdmin      = lazy(() => import('./pages/SuperAdmin'));

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={user ? <Navigate to="/cellars" replace /> : <Login />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Protected routes wrapped in Layout */}
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/cellars"
          element={
            <ProtectedRoute>
              <Layout><Cellars /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id"
          element={
            <ProtectedRoute>
              <Layout><CellarDetail /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/add-bottle"
          element={
            <ProtectedRoute>
              <Layout><AddBottle /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/import"
          element={
            <ProtectedRoute>
              <Layout><ImportBottles /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/racks"
          element={
            <ProtectedRoute>
              <Layout><CellarRacks /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/bottles/:bottleId"
          element={
            <ProtectedRoute>
              <Layout><BottleDetail /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/history"
          element={
            <ProtectedRoute>
              <Layout><CellarHistory /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/audit"
          element={
            <ProtectedRoute>
              <Layout><CellarAudit /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/wine-requests"
          element={
            <ProtectedRoute>
              <Layout><WineRequests /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellar-chat"
          element={
            <ProtectedRoute>
              <Layout><CellarChat /></Layout>
            </ProtectedRoute>
          }
        />

        {/* Community routes */}
        <Route
          path="/community"
          element={
            <ProtectedRoute>
              <Layout><ReviewFeed /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/users/:userId"
          element={
            <ProtectedRoute>
              <Layout><UserProfile /></Layout>
            </ProtectedRoute>
          }
        />

        {/* Sommelier routes */}
        <Route
          path="/somm/maturity"
          element={
            <ProtectedRoute requireSomm>
              <Layout><SommMaturity /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/somm/prices"
          element={
            <ProtectedRoute requireSomm>
              <Layout><SommPrices /></Layout>
            </ProtectedRoute>
          }
        />

        {/* Settings */}
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <Layout><Settings /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/plans"
          element={
            <ProtectedRoute>
              <Layout><Plans /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/statistics"
          element={
            <ProtectedRoute>
              <Layout><Statistics /></Layout>
            </ProtectedRoute>
          }
        />

        {/* Admin routes */}
        <Route
          path="/admin/wines"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminWines /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/requests"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminRequests /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/taxonomy"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminTaxonomy /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/images"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminImages /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/support"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminSupportTickets /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/wine-reports"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminWineReports /></Layout>
            </ProtectedRoute>
          }
        />

        {/* Support page (user-facing) */}
        <Route
          path="/support"
          element={
            <ProtectedRoute>
              <Layout><SupportPage /></Layout>
            </ProtectedRoute>
          }
        />

        {/* Super Admin — rendered without Layout (own full-screen shell) */}
        <Route
          path="/superadmin"
          element={
            <ProtectedRoute requireSuperAdmin>
              <SuperAdmin />
            </ProtectedRoute>
          }
        />

        {/* 404 fallback */}
        <Route path="*" element={<Navigate to={user ? '/cellars' : '/login'} replace />} />
      </Routes>
    </Suspense>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <NotificationProvider>
            <AppRoutes />
          </NotificationProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
