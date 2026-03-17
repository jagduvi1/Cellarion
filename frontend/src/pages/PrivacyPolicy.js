import './PrivacyPolicy.css';

function PrivacyPolicy() {
  return (
    <div className="privacy-page">
      <div className="privacy-container">
        <h1>Privacy Policy</h1>
        <p className="privacy-updated">Last updated: March 2026</p>

        <p>
          Cellarion ("we", "us", or "our") operates the Cellarion wine cellar management
          service available at <a href="https://cellarion.app">cellarion.app</a> and via the
          Cellarion Android app. This policy explains what data we collect, why we collect it,
          and how you can control it.
        </p>

        <h2>Data we collect</h2>
        <ul>
          <li><strong>Account information:</strong> email address, username, and password (stored as a bcrypt hash — we never store your plain-text password).</li>
          <li><strong>Cellar data:</strong> bottles, cellars, racks, tasting notes, ratings, and wine images you add to your account.</li>
          <li><strong>Profile information:</strong> optional display name, bio, and profile visibility preference.</li>
          <li><strong>Usage data:</strong> actions you take in the app (e.g. adding a bottle, writing a review) are stored in an activity log to help us maintain the service.</li>
        </ul>

        <h2>How we use your data</h2>
        <ul>
          <li>To provide and operate the Cellarion service.</li>
          <li>To authenticate you and keep your cellar data private.</li>
          <li>To send you notifications you have opted into within the app.</li>
        </ul>

        <h2>Data sharing</h2>
        <p>
          We do not sell, rent, or share your personal data with third parties for marketing
          purposes. Your cellar data is private by default and is only visible to you and
          anyone you explicitly share a cellar with.
        </p>

        <h2>Data security</h2>
        <p>
          All data is transmitted over HTTPS. Passwords are hashed with bcrypt and never
          stored in plain text. We use industry-standard security practices to protect your
          data at rest and in transit.
        </p>

        <h2>Data retention</h2>
        <p>
          Your data is retained for as long as your account is active. You can delete your
          account at any time from <a href="/settings">Settings → Danger zone</a>, which
          permanently removes your account and all associated data.
        </p>

        <h2>Your rights</h2>
        <ul>
          <li><strong>Access:</strong> you can view all your data within the app at any time.</li>
          <li><strong>Deletion:</strong> you can permanently delete your account and all data from the Settings page.</li>
          <li><strong>Portability:</strong> you can export your cellar data as CSV from the app.</li>
        </ul>

        <h2>Cookies</h2>
        <p>
          Cellarion uses a single authentication cookie to keep you logged in. No tracking
          or advertising cookies are used.
        </p>

        <h2>Contact</h2>
        <p>
          If you have questions about this policy or your data, contact us at{' '}
          <a href="mailto:privacy@cellarion.app">privacy@cellarion.app</a>.
        </p>
      </div>
    </div>
  );
}

export default PrivacyPolicy;
