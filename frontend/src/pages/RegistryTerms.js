import { Helmet } from 'react-helmet-async';
import { SHIPPED_CODES } from 'virtual:locale-coverage';
import SITE_URL from '../config/siteUrl';
import './PrivacyPolicy.css';

// Registry Data Terms (registry lockdown 2026-09-06, layer L6). The code is
// AGPL; the shared registry's curated content — tasting profiles, drink
// windows, sommelier notes, curated values — is not, and this page is where
// that is said, in plain language: house rules for an open-source project,
// not a contract drafted by counsel (Johan, 2026-09-06). The mechanics it
// describes (per-reader budgets, terms-bound keys) are what actually holds.
// Reuses the privacy page's layout so the two legal pages read as one set.
function RegistryTerms() {
  return (
    <div className="privacy-page">
      <Helmet>
        <title>Registry Data Terms — Cellarion</title>
        <meta name="description" content="Terms for using Cellarion's shared wine registry: personal use through the app and documented interfaces, no bulk extraction or redistribution." />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Registry Data Terms — Cellarion" />
        <meta property="og:description" content="Terms for using Cellarion's shared wine registry." />
        <meta property="og:url" content={`${SITE_URL}/terms`} />
        <link rel="canonical" href={`${SITE_URL}/terms`} />
        {SHIPPED_CODES.map((code) => (
          <link key={code} rel="alternate" hrefLang={code} href={`${SITE_URL}/terms`} />
        ))}
        <link rel="alternate" hrefLang="x-default" href={`${SITE_URL}/terms`} />
      </Helmet>
      <div className="privacy-container">
        <h1>Registry Data Terms</h1>
        <p className="privacy-updated">Version 2026-09</p>

        <p>
          Cellarion's code is open source under the AGPL-3.0 licence. The <strong>shared wine
          registry</strong> is something else: a curated database of wines, tasting profiles,
          drink windows, sommelier notes and community-contributed values, built and verified
          over time by Cellarion and its members. These terms say how that content may be used.
          They apply to everyone who reads it, whether through the app, the public wine pages,
          the API, the MCP endpoints, or a self-hosted installation connected to cellarion.app.
        </p>

        <h2>1. What you may do</h2>
        <ul>
          <li>Read, search and use registry content for your own cellar and your own wine questions, through the app and its documented interfaces.</li>
          <li>Quote and cite individual wines, with a link to their page on cellarion.app, in articles, forums, and answers an AI assistant gives on your behalf.</li>
          <li>Export your own cellar, including the identity of the wines in it, in any format the app offers. That is your data and it always leaves with you.</li>
          <li>Connect a self-hosted Cellarion to the registry with a Registry Bridge key, look up the wines your users add, and cache those wines locally for that installation.</li>
        </ul>

        <h2>2. What you may not do</h2>
        <ul>
          <li>Copy the registry, or a substantial part of it, by any means: crawling the wine pages, paging the API or the taxonomy listings, walking the similar-wines graph, scripting the MCP endpoints, or pooling Bridge keys or accounts.</li>
          <li>Mirror, redistribute, sell or sublicense registry content, or build another database, product or dataset from it.</li>
          <li>Use registry content as training or evaluation material for machine-learning models. Answering a person's question about a wine with a citation is fine; ingesting the registry is not.</li>
          <li>Circumvent reading budgets, rate limits, key quotas or the distinction between what anonymous and signed-in readers receive.</li>
        </ul>

        <h2>3. Automated access</h2>
        <p>
          Machines are welcome through the documented interfaces: the public wine pages for
          search engines and AI crawlers, the public MCP endpoint for AI assistants, the API
          and the Registry Bridge for connected installations. Each carries reading budgets
          sized far above personal use. Anonymous reads are counted per address per day and
          refused past the daily limit; signed-in reads are counted and reviewed. Registry
          Bridge keys are issued to accounts that accept these terms, carry quotas, and may be
          revoked when a key is used to copy rather than to look up.
        </p>

        <h2>4. Contributions</h2>
        <p>
          When you suggest a wine, propose a correction, contribute a value such as an alcohol
          level, write a sommelier note, or upload a label image, you grant Cellarion a
          perpetual, worldwide, royalty-free licence to use, adapt and publish that contribution
          as part of the registry, and you confirm you have the right to give it. Contributors
          are credited in the app. Your bottles, notes and ratings are never part of the
          registry and stay yours.
        </p>

        <h2>5. Our rights</h2>
        <p>
          Cellarion holds copyright in the registry's original text and images, and the
          database right under Directive 96/9/EC on the registry as a whole, reflecting the
          substantial investment in obtaining, verifying and presenting its contents. The
          registry also contains marker entries that identify copies. We reserve these rights.
        </p>

        <h2>6. Enforcement</h2>
        <p>
          Reading past the limits stops working, and keys or accounts used for copying are
          revoked. If a copy of the registry turns up elsewhere, we will ask for it to be taken
          down and reserve our rights. None of this applies to a person using the app for their
          own wine, which is what everything here is for.
        </p>

        <h2>7. Changes and contact</h2>
        <p>
          We may update these terms; the version and date at the top change when we do, and
          material changes are announced in the app. Questions go to{' '}
          <a href="mailto:support@cellarion.app">support@cellarion.app</a>. Personal data is
          covered separately by the <a href="/privacy">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}

export default RegistryTerms;
