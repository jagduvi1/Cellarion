import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { ThemeProvider } from './contexts/ThemeContext';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import ReconsentModal from './components/ReconsentModal';
import Analytics from './components/Analytics';
import './styles/common.css';

// Lazy-load all pages so each route gets its own chunk.
// The initial bundle only includes Layout, ProtectedRoute, and routing logic.
const LandingPage     = lazy(() => import('./pages/LandingPage'));
const Login           = lazy(() => import('./pages/Login'));
const OAuthCallback   = lazy(() => import('./pages/OAuthCallback'));
const ConnectAiAuthorize = lazy(() => import('./pages/ConnectAiAuthorize'));
const VerifyEmail     = lazy(() => import('./pages/VerifyEmail'));
const ResetPassword   = lazy(() => import('./pages/ResetPassword'));
const PrivacyPolicy   = lazy(() => import('./pages/PrivacyPolicy'));
const Cellars         = lazy(() => import('./pages/Cellars'));
const CellarDetail    = lazy(() => import('./pages/CellarDetail'));
const AddBottle       = lazy(() => import('./pages/AddBottle'));
const ImportBottles   = lazy(() => import('./pages/ImportBottles'));
const ImportCellar    = lazy(() => import('./pages/ImportCellar'));
const ExportCellar    = lazy(() => import('./pages/ExportCellar'));
const CellarRacks     = lazy(() => import('./pages/CellarRacks'));
const CellarBook      = lazy(() => import('./pages/CellarBook'));
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
const Supporter       = lazy(() => import('./pages/Supporter'));
const Statistics      = lazy(() => import('./pages/Statistics'));
const Bottles         = lazy(() => import('./pages/Bottles'));
const StatsCard       = lazy(() => import('./pages/StatsCard'));
const AdminWines      = lazy(() => import('./pages/AdminWines'));
const AdminRequests   = lazy(() => import('./pages/AdminRequests'));
const AdminTaxonomy   = lazy(() => import('./pages/AdminTaxonomy'));
const AdminImages     = lazy(() => import('./pages/AdminImages'));
const AdminSupportTickets = lazy(() => import('./pages/AdminSupportTickets'));
const AdminWineReports    = lazy(() => import('./pages/AdminWineReports'));
const AdminAiBudgetRequests = lazy(() => import('./pages/AdminAiBudgetRequests'));
const AdminModerators     = lazy(() => import('./pages/AdminModerators'));
const AdminModerationReports = lazy(() => import('./pages/AdminModerationReports'));
const SupportPage     = lazy(() => import('./pages/SupportPage'));
const SuperAdmin      = lazy(() => import('./pages/SuperAdmin'));
const CommunityDiscussions = lazy(() => import('./pages/CommunityDiscussions'));
const DiscussionDetail     = lazy(() => import('./pages/DiscussionDetail'));
const CellarRoom           = lazy(() => import('./pages/CellarRoom'));
const Blog                 = lazy(() => import('./pages/Blog'));
const BlogPost             = lazy(() => import('./pages/BlogPost'));
const AdminBlog            = lazy(() => import('./pages/AdminBlog'));
const AdminStats           = lazy(() => import('./pages/AdminStats'));
const AdminMcp             = lazy(() => import('./pages/AdminMcp'));
const AdminBlogEditor      = lazy(() => import('./pages/AdminBlogEditor'));
const NfcRedirect          = lazy(() => import('./pages/NfcRedirect'));
const Wishlist             = lazy(() => import('./pages/Wishlist'));
const AddToWishlist        = lazy(() => import('./pages/AddToWishlist'));
const Unsubscribed         = lazy(() => import('./pages/Unsubscribed'));
const Recommendations      = lazy(() => import('./pages/Recommendations'));
const Journal              = lazy(() => import('./pages/Journal'));
const Restock              = lazy(() => import('./pages/Restock'));
const WineDetail           = lazy(() => import('./pages/WineDetail'));
const RegionDetail         = lazy(() => import('./pages/RegionDetail'));
const CountryDetail        = lazy(() => import('./pages/CountryDetail'));
const GrapeDetail          = lazy(() => import('./pages/GrapeDetail'));
const WineTypeDetail       = lazy(() => import('./pages/WineTypeDetail'));
const Help                 = lazy(() => import('./pages/Help'));
const ConnectAi            = lazy(() => import('./pages/ConnectAi'));
const WineLists            = lazy(() => import('./pages/WineLists'));
const WineListEditor       = lazy(() => import('./pages/WineListEditor'));
const PublicWineList       = lazy(() => import('./pages/PublicWineList'));

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
    <>
    <Suspense fallback={null}>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={user ? <Navigate to="/cellars" replace /> : <Login />} />
        <Route path="/login/callback" element={<OAuthCallback />} />
        {/* OAuth 2.1 consent for MCP AI connectors. NOT ProtectedRoute — the page
            renders an inline login when logged out so the OAuth params survive
            (a /login bounce would drop them). */}
        <Route path="/connect-ai/authorize" element={<ConnectAiAuthorize />} />
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
          path="/import-cellar"
          element={
            <ProtectedRoute>
              <Layout><ImportCellar /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/export-cellar"
          element={
            <ProtectedRoute>
              <Layout><ExportCellar /></Layout>
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
        {/* No Layout — the book prints as a clean document without app chrome */}
        <Route
          path="/cellars/:id/book"
          element={
            <ProtectedRoute>
              <CellarBook />
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/wine-lists"
          element={
            <ProtectedRoute>
              <Layout><WineLists /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/cellars/:id/wine-lists/:listId/edit"
          element={
            <ProtectedRoute>
              <Layout><WineListEditor /></Layout>
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

        {/* Community routes — discussions are publicly readable; reply/post requires auth.
            ReviewFeed (the "Reviews" tab) stays auth-only since its primary value is
            following users — opening it up is a separate enhancement. */}
        <Route
          path="/community"
          element={
            user ? <Layout><ReviewFeed /></Layout> : <Navigate to="/community/discussions" replace />
          }
        />
        <Route path="/community/discussions" element={<Layout><CommunityDiscussions /></Layout>} />
        <Route path="/community/discussions/:idOrSlug" element={<Layout><DiscussionDetail /></Layout>} />
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
          path="/supporter"
          element={
            <ProtectedRoute>
              <Layout><Supporter /></Layout>
            </ProtectedRoute>
          }
        />
        {/* Redirect old /plans URL */}
        <Route path="/plans" element={<Navigate to="/supporter" replace />} />
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
        <Route
          path="/bottles"
          element={
            <ProtectedRoute>
              <Layout><Bottles /></Layout>
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
        <Route path="/menu/:token" element={<PublicWineList />} />
        <Route path="/wines/:idOrSlug" element={<WineDetail />} />
        <Route path="/wines/type/:type" element={<WineTypeDetail />} />
        <Route path="/regions/:slug" element={<RegionDetail />} />
        <Route path="/countries/:slug" element={<CountryDetail />} />
        <Route path="/grapes/:slug" element={<GrapeDetail />} />
        <Route path="/blog" element={<Layout><Blog /></Layout>} />
        <Route path="/blog/:slug" element={<Layout><BlogPost /></Layout>} />
        <Route path="/help" element={<Layout><Help /></Layout>} />
        {/* Public set-up docs for the MCP connector. Distinct from
            /connect-ai/authorize above, which is the OAuth consent screen. */}
        <Route path="/connect-ai" element={<Layout><ConnectAi /></Layout>} />

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
          path="/admin/ai-budget-requests"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminAiBudgetRequests /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/moderators"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminModerators /></Layout>
            </ProtectedRoute>
          }
        />
        {/* Moderator OR admin — mirrors the backend's requireModeratorOrAdmin */}
        <Route
          path="/admin/moderation-reports"
          element={
            <ProtectedRoute requireModerator>
              <Layout><AdminModerationReports /></Layout>
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
          path="/admin/stats"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminStats /></Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/mcp"
          element={
            <ProtectedRoute requireAdmin>
              <Layout><AdminMcp /></Layout>
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
    <ReconsentModal />
    </>
  );
}

function App() {
  return (
    <HelmetProvider>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <NotificationProvider>
                <Analytics />
                <AppRoutes />
            </NotificationProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </HelmetProvider>
  );
}

export default App;
