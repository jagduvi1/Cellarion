import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
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
const PrivacyPolicy   = lazy(() => import('./pages/PrivacyPolicy'));
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
const StatsCard       = lazy(() => import('./pages/StatsCard'));
const AdminWines      = lazy(() => import('./pages/AdminWines'));
const AdminRequests   = lazy(() => import('./pages/AdminRequests'));
const AdminTaxonomy   = lazy(() => import('./pages/AdminTaxonomy'));
const AdminImages     = lazy(() => import('./pages/AdminImages'));
const AdminSupportTickets = lazy(() => import('./pages/AdminSupportTickets'));
const AdminWineReports    = lazy(() => import('./pages/AdminWineReports'));
const SupportPage     = lazy(() => import('./pages/SupportPage'));
const SuperAdmin      = lazy(() => import('./pages/SuperAdmin'));
const CommunityDiscussions = lazy(() => import('./pages/CommunityDiscussions'));
const DiscussionDetail     = lazy(() => import('./pages/DiscussionDetail'));
const CellarRoom           = lazy(() => import('./pages/CellarRoom'));
const Blog                 = lazy(() => import('./pages/Blog'));
const BlogPost             = lazy(() => import('./pages/BlogPost'));
const AdminBlog            = lazy(() => import('./pages/AdminBlog'));
const AdminBlogEditor      = lazy(() => import('./pages/AdminBlogEditor'));
const NfcRedirect          = lazy(() => import('./pages/NfcRedirect'));
const Wishlist             = lazy(() => import('./pages/Wishlist'));
const AddToWishlist        = lazy(() => import('./pages/AddToWishlist'));
const Unsubscribed         = lazy(() => import('./pages/Unsubscribed'));
const Recommendations      = lazy(() => import('./pages/Recommendations'));
const Journal              = lazy(() => import('./pages/Journal'));
const Restock              = lazy(() => import('./pages/Restock'));
const WineDetail           = lazy(() => import('./pages/WineDetail'));

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
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/unsubscribed" element={<Unsubscribed />} />

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
          path="/cellars/:id/room"
          element={
            <ProtectedRoute>
              <Layout><CellarRoom /></Layout>
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
          path="/wishlist"
          element={
            <ProtectedRoute>
              <Layout><Wishlist /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/wishlist/add"
          element={
            <ProtectedRoute>
              <Layout><AddToWishlist /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/recommendations"
          element={
            <ProtectedRoute>
              <Layout><Recommendations /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/journal"
          element={
            <ProtectedRoute>
              <Layout><Journal /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/restock"
          element={
            <ProtectedRoute>
              <Layout><Restock /></Layout>
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
          path="/community/discussions"
          element={
            <ProtectedRoute>
              <Layout><CommunityDiscussions /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/community/discussions/:id"
          element={
            <ProtectedRoute>
              <Layout><DiscussionDetail /></Layout>
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
        <Route
          path="/statistics/card"
          element={
            <ProtectedRoute>
              <Layout><StatsCard /></Layout>
            </ProtectedRoute>
          }
        />

        {/* NFC tag redirect — resolves rack ID to cellar and navigates */}
        <Route
          path="/nfc/rack/:rackId"
          element={
            <ProtectedRoute>
              <Layout><NfcRedirect /></Layout>
            </ProtectedRoute>
          }
        />

        {/* Public content — no auth required */}
        <Route path="/wines/:id" element={<WineDetail />} />
        <Route path="/blog" element={<Layout><Blog /></Layout>} />
        <Route path="/blog/:slug" element={<Layout><BlogPost /></Layout>} />

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
        <Route
          path="/admin/blog"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminBlog /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/blog/new"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminBlogEditor /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/blog/:id"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminBlogEditor /></Layout>
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
    <HelmetProvider>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <NotificationProvider>
              <AppRoutes />
            </NotificationProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </HelmetProvider>
  );
}

export default App;
