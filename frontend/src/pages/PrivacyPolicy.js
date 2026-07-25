import { Helmet } from 'react-helmet-async';
import { SHIPPED_CODES } from 'virtual:locale-coverage';
import SITE_URL from '../config/siteUrl';
import './PrivacyPolicy.css';

function PrivacyPolicy() {
  return (
    <div className="privacy-page">
      <Helmet>
        <title>Privacy Policy — Cellarion</title>
        <meta name="description" content="Cellarion privacy policy. Learn how we collect, use, and protect your personal data under GDPR." />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Privacy Policy — Cellarion" />
        <meta property="og:description" content="Cellarion privacy policy. Learn how we collect, use, and protect your personal data under GDPR." />
        <meta property="og:url" content={`${SITE_URL}/privacy`} />
        <link rel="canonical" href={`${SITE_URL}/privacy`} />
        {SHIPPED_CODES.map((code) => (
          <link key={code} rel="alternate" hrefLang={code} href={`${SITE_URL}/privacy`} />
        ))}
        <link rel="alternate" hrefLang="x-default" href={`${SITE_URL}/privacy`} />
      </Helmet>
      <div className="privacy-container">
        <h1>Privacy Policy</h1>
        <p className="privacy-updated">Last updated: July 2026 — Version 2026-07</p>

        <p>
          Cellarion ("we", "us", or "our") operates the Cellarion wine cellar management
          service available at <a href="https://cellarion.app">cellarion.app</a> and via the
          Cellarion Android app. This policy explains what data we collect, why we collect it,
          how we share it, and how you can exercise your rights under the EU General Data
          Protection Regulation (GDPR) and other applicable data protection laws.
        </p>

        <h2>1. Data controller</h2>
        <p>
          The data controller responsible for your personal data is Cellarion.
          You can contact us at{' '}
          <a href="mailto:privacy@cellarion.app">privacy@cellarion.app</a> for any
          data protection queries.
        </p>

        <h2>2. Legal basis for processing</h2>
        <ul>
          <li><strong>Contract performance (Art. 6(1)(b) GDPR):</strong> processing your account data, cellar data, and preferences is necessary to provide the Cellarion service you signed up for.</li>
          <li><strong>Consent (Art. 6(1)(a) GDPR):</strong> we process your data for optional features (email notifications, label scanning via AI, connecting an external AI assistant) only with your explicit consent, which you can withdraw at any time.</li>
          <li><strong>Legitimate interest (Art. 6(1)(f) GDPR):</strong> we maintain activity logs and security measures to protect the service and its users.</li>
        </ul>

        <h2>3. Data we collect</h2>
        <ul>
          <li><strong>Account information:</strong> email address, username, and password (stored as a bcrypt hash — we never store your plain-text password).</li>
          <li><strong>Profile information:</strong> optional display name, bio, and profile visibility preference.</li>
          <li><strong>Cellar data:</strong> bottles, cellars, racks, tasting notes, ratings, purchase information, and wine images you add to your account.</li>
          <li><strong>Community / forum data:</strong> discussions and replies you post, reactions you add to other users' replies, threads you subscribe to ("watch"), and read-state markers tracking which threads you've opened (used to drive the unread indicator).</li>
          <li><strong>Activity logs:</strong> actions you take in the app (e.g. adding a bottle, logging in) are logged with your user ID, IP address, and browser user-agent for security and service maintenance purposes.</li>
          <li><strong>Consent records:</strong> timestamps of when you accepted this privacy policy and consented to data processing.</li>
          <li><strong>AI-connector records:</strong> if you connect an AI assistant (see section 5), we store the connection's metadata (name, permission scopes, a hashed credential — never the plain token — and last-used time) and an action log of what the assistant did in your account (which tool ran, what changed, and the undo snapshot).</li>
        </ul>

        <h2>4. How we use your data</h2>
        <ul>
          <li>To provide and operate the Cellarion service, including authentication and cellar management.</li>
          <li>To send you notifications you have opted into (drink-window alerts, email digests, push notifications).</li>
          <li>To process bottle label images for wine identification (when you use the label scanning feature).</li>
          <li>To maintain security, prevent abuse, and investigate incidents via activity logs.</li>
          <li>To operate AI-assistant connections you set up yourself (see section 5), including the action trail that lets you review and undo changes a connected assistant made.</li>
        </ul>

        <h2>5. Data sharing and sub-processors</h2>
        <p>
          We do not sell, rent, or share your personal data with third parties for marketing
          purposes. Your cellar data is private by default and is only visible to you and
          anyone you explicitly share a cellar with.
        </p>
        <p>We use the following third-party services (sub-processors) to operate Cellarion:</p>
        <table className="privacy-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Purpose</th>
              <th>Data shared</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Mailgun</td>
              <td>Transactional email delivery</td>
              <td>Email address, username, bottle names (in digest emails)</td>
              <td>US/EU</td>
            </tr>
            <tr>
              <td>Anthropic (Claude API)</td>
              <td>Wine label scanning and AI cellar chat</td>
              <td>Bottle label images, wine metadata, chat messages</td>
              <td>US</td>
            </tr>
            <tr>
              <td>Voyage AI</td>
              <td>Text embeddings that power AI cellar chat / similarity search</td>
              <td>Chat query text and wine metadata</td>
              <td>US</td>
            </tr>
            <tr>
              <td>Stripe</td>
              <td>Subscription billing and payment processing</td>
              <td>Email, name, and payment details (entered with and stored by Stripe)</td>
              <td>US/EU</td>
            </tr>
            <tr>
              <td>Cloudflare</td>
              <td>CDN, DNS, and DDoS / bot protection for cellarion.app</td>
              <td>IP address and request metadata for traffic reaching the site</td>
              <td>Global (EU/US)</td>
            </tr>
          </tbody>
        </table>
        <p>
          The following components run on Cellarion's own infrastructure and are not third-party
          sub-processors: <strong>Meilisearch</strong> (wine search), <strong>Qdrant</strong>
          (vector storage for AI cellar chat), <strong>rembg</strong> (image background removal),
          and <strong>Umami</strong> (privacy-friendly, cookieless usage analytics). Self-hosted
          Cellarion instances run all of these themselves; the hosted cellarion.app additionally
          uses Stripe, Voyage AI and Cloudflare as noted above.
        </p>

        <h3>AI assistants you connect (MCP)</h3>
        <p>
          Cellarion lets you connect an AI assistant of your choice (for example Claude or
          ChatGPT) to your cellar via the Model Context Protocol (MCP), using a personal
          access token or an authorization you approve on a consent screen. This feature is
          entirely opt-in: no data flows to any AI assistant until you connect one yourself.
        </p>
        <ul>
          <li><strong>What is shared:</strong> when your assistant queries Cellarion on your behalf, the data those requests return (bottles, cellars, tasting notes, statistics) is processed by that assistant's provider under <em>that provider's</em> privacy policy — so choose a provider you trust. Depending on your choice, this can involve a transfer outside the EU/EEA that you initiate.</li>
          <li><strong>Who the assistant acts for:</strong> a connected assistant acts on your instructions, as your agent. Unlike the sub-processors listed above, its provider is chosen and engaged by you, not by Cellarion.</li>
          <li><strong>Your controls:</strong> access is limited to the permission scopes you grant (read / consume / write / climate), every action the assistant takes is recorded in an activity trail you can review in the app, consequential changes require confirmation and are reversible, and you can revoke a connection at any time in Settings with immediate effect.</li>
          <li><strong>Anonymous public tools:</strong> Cellarion also offers a public MCP endpoint that serves only shared, non-personal wine knowledge (wine facts, drink windows, guides). It requires no account and processes no personal data beyond standard rate-limiting metadata.</li>
        </ul>

        <h2>6. Data security</h2>
        <p>
          All data is transmitted over HTTPS. Passwords are hashed with bcrypt (10 salt rounds)
          and never stored in plain text. Authentication uses short-lived JWT access tokens (15 minutes)
          and secure, httpOnly refresh token cookies. We use industry-standard security practices
          to protect your data at rest and in transit.
        </p>

        <h2>7. Data retention</h2>
        <ul>
          <li><strong>Account data:</strong> retained for as long as your account is active.</li>
          <li><strong>Activity logs:</strong> automatically deleted after 90 days.</li>
          <li><strong>AI-connector action log:</strong> automatically deleted after 90 days. The connection itself (token metadata) remains until you revoke it or delete your account.</li>
          <li><strong>Deleted cellars/racks:</strong> soft-deleted and permanently removed after 30 days.</li>
          <li><strong>Account deletion:</strong> when you request account deletion, there is a 7-day cooling-off period. After that, your personal data (account, cellar, bottles, journal, settings, forum reactions, thread subscriptions, read-state markers, reports) is permanently and irreversibly deleted.</li>
          <li><strong>Forum content (discussions and replies):</strong> to preserve multi-party conversations for other users, your forum posts are <em>anonymised</em> rather than hard-deleted — your authorship is replaced with "[Deleted user]" and the personal-data link is severed (GDPR Art. 17 compliant). The post text remains visible. If you need a specific post fully removed, contact support before requesting account deletion.</li>
        </ul>

        <h2>8. Your rights (GDPR)</h2>
        <p>Under the GDPR, you have the following rights regarding your personal data:</p>
        <ul>
          <li><strong>Right of access (Art. 15):</strong> you can view all your data within the app at any time. You can also download a complete export of your data from Settings.</li>
          <li><strong>Right to rectification (Art. 16):</strong> you can update your profile, preferences, and cellar data at any time.</li>
          <li><strong>Right to erasure (Art. 17):</strong> you can delete your account and all associated personal data from Settings. Deletion takes effect after a 7-day cooling-off period. Forum posts are anonymised rather than hard-deleted (your authorship is severed) so other users' conversations stay intact; contact support if you need specific posts fully removed.</li>
          <li><strong>Right to data portability (Art. 20):</strong> you can export all your data as JSON from Settings at any time.</li>
          <li><strong>Right to restrict processing (Art. 18):</strong> you can disable all notifications and set your profile to private to restrict how your data is used.</li>
          <li><strong>Right to object (Art. 21):</strong> you can opt out of all email and push notifications in Settings, or use the one-click unsubscribe link in any email.</li>
          <li><strong>Right to withdraw consent (Art. 7):</strong> you can withdraw consent for optional data processing at any time by disabling the relevant features, revoking a connected AI assistant in Settings, or deleting your account.</li>
        </ul>
        <p>
          To exercise any of these rights or if you have concerns about our data practices,
          contact us at <a href="mailto:privacy@cellarion.app">privacy@cellarion.app</a>.
          We will respond to your request within 30 days.
        </p>

        <h2>9. Cookies</h2>
        <p>
          Cellarion uses a single httpOnly authentication cookie to keep you logged in.
          This cookie is strictly necessary for the service to function and does not require
          separate consent. On the hosted cellarion.app, Cloudflare may also set a strictly-necessary
          security cookie to distinguish humans from bots. No tracking, analytics, or advertising
          cookies are used (our Umami analytics is cookieless).
        </p>

        <h2>10. International data transfers</h2>
        <p>
          Some of our sub-processors (Mailgun, Anthropic, Voyage AI, Stripe, Cloudflare) are based in
          or route traffic through the United States. Where personal data is transferred outside the
          EU/EEA, we ensure appropriate safeguards are in place, such as Standard Contractual Clauses
          (SCCs) or the EU-US Data Privacy Framework.
        </p>

        <h2>11. Changes to this policy</h2>
        <p>
          We may update this policy from time to time. If we make material changes, we will
          notify registered users via email or in-app notification. The version number and
          date at the top of this page indicate the most recent revision.
        </p>

        <h2>12. Contact</h2>
        <p>
          If you have questions about this policy, your data, or wish to file a complaint,
          contact us at{' '}
          <a href="mailto:privacy@cellarion.app">privacy@cellarion.app</a>.
        </p>
        <p>
          You also have the right to lodge a complaint with your local data protection
          supervisory authority.
        </p>
      </div>
    </div>
  );
}

export default PrivacyPolicy;
