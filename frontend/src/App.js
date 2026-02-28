import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Cellars from './pages/Cellars';
import CellarDetail from './pages/CellarDetail';
import AddBottle from './pages/AddBottle';
import Wines from './pages/Wines';
import WineRequests from './pages/WineRequests';
import AdminRequests from './pages/AdminRequests';
import AdminTaxonomy from './pages/AdminTaxonomy';
import AdminImages from './pages/AdminImages';
import AdminAudit from './pages/AdminAudit';
import AdminUsers from './pages/AdminUsers';
import AdminSettings from './pages/AdminSettings';
import CellarAudit from './pages/CellarAudit';
import CellarRacks from './pages/CellarRacks';
import DrinkAlerts from './pages/DrinkAlerts';
import CellarHistory from './pages/CellarHistory';
import BottleDetail from './pages/BottleDetail';
import SommMaturity from './pages/SommMaturity';
import SommPrices from './pages/SommPrices';
import Settings from './pages/Settings';
import VerifyEmail from './pages/VerifyEmail';
import './styles/common.css';

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
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={user ? <Navigate to="/cellars" replace /> : <Login />} />
      <Route path="/verify-email" element={<VerifyEmail />} />

      {/* Protected routes wrapped in Layout */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout><Navigate to="/cellars" replace /></Layout>
          </ProtectedRoute>
        }
      />
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
        path="/cellars/:id/drink-alerts"
        element={
          <ProtectedRoute>
            <Layout><DrinkAlerts /></Layout>
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
        path="/wines"
        element={
          <ProtectedRoute requireAdmin>
            <Layout><Wines /></Layout>
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

      {/* Admin routes */}
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
        path="/admin/audit"
        element={
          <ProtectedRoute requireAdmin>
            <Layout><AdminAudit /></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          <ProtectedRoute requireAdmin>
            <Layout><AdminUsers /></Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <ProtectedRoute requireAdmin>
            <Layout><AdminSettings /></Layout>
          </ProtectedRoute>
        }
      />

      {/* 404 fallback */}
      <Route path="*" element={<Navigate to={user ? '/cellars' : '/login'} replace />} />
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
