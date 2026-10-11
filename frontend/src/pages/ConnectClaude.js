import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import SEOHead from '../components/SEOHead';
import ConnectSnippet from '../components/ConnectSnippet';
import SITE_URL from '../config/siteUrl';
import { HOSTED_ORIGIN, isHostedOrigin, claudeOneClickUrl } from '../utils/mcpConnect';
import { track } from '../utils/track';
import './ConnectAi.css';
import './ConnectClaude.css';

const EXAMPLE_KEYS = ['ex1', 'ex2', 'ex3', 'ex4', 'ex5', 'ex6'];

/**
 * /connect-ai/claude — the beginner's guide to the MCP connector, written for
 * someone who has never added a connector to an AI assistant. Cellar Chat
 * points here; the technical /connect-ai page (every client, raw protocol
 * details) links back for anyone new to it. Crawlers get the server-rendered
 * twin in backend/src/routes/og.js — keep the two in step.
 *
 * Facts about Claude's plans and menus were checked against Anthropic's help
 * centre on 2026-10-11 ("Get started with custom connectors using remote
 * MCP"): the Free plan may add ONE custom connector; the path is Customize →
 * Connectors → + Add → Add custom connector; a connector added on the web or
 * desktop is available in the iOS and Android apps afterwards. Re-check them
 * when Anthropic changes its plans.
 */
function ConnectClaude() {
  const { t } = useTranslation();
  const origin = typeof window !== 'undefined' ? window.location.origin : HOSTED_ORIGIN;
  const hosted = isHostedOrigin(origin);
  const mcpUrl = `${origin}/api/mcp`;

  const title = t('connectClaude.title', 'Ask Claude about your wine cellar');
  const intro = t(
    'connectClaude.intro',
    'Cellar Chat is made for quick questions. Connect Cellarion to Claude and your whole cellar joins a full conversation: Claude can look through every bottle, count and compare, and, if you allow it, log what you drink and add new bottles for you.',
  );
  const copyLabel = t('connectAi.copy', 'Copy');
  const copiedLabel = t('connectAi.copied', 'Copied');
  const address = (
    <ConnectSnippet text={mcpUrl} copyLabel={copyLabel} copiedLabel={copiedLabel} via="claude-guide-copy" />
  );

  // Each step carries its own extra content, so its button or address box
  // can never come apart from its text.
  const steps = [
    {
      id: 'account',
      title: t('connectClaude.steps.account.title', 'Get a Claude account'),
      body: t(
        'connectClaude.steps.account.body',
        'Go to claude.ai and sign up for free, or sign in if you already have an account.',
      ),
      extra: (
        <a className="btn btn-secondary btn-small" href="https://claude.ai" target="_blank" rel="noopener noreferrer">
          {t('connectClaude.steps.account.cta', 'Open claude.ai')}
        </a>
      ),
    },
    hosted
      ? {
        id: 'add',
        title: t('connectClaude.steps.add.title', 'Add Cellarion to Claude'),
        body: t(
          'connectClaude.steps.add.bodyOneClick',
          'Click the button below. It opens Claude with Cellarion already filled in, so all you do there is click Add.',
        ),
        extra: (
          <>
            <a
              className="btn btn-primary"
              href={claudeOneClickUrl(origin)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('ai-connect-started', { via: 'claude-guide' })}
            >
              {t('connectAi.oneClick.cta', 'Add Cellarion to Claude')}
            </a>
            <p className="connect-ai-note connect-claude-fallback">
              {t(
                'connectClaude.steps.add.fallback',
                'Button not working? In Claude, open Customize → Connectors, click + Add and choose Add custom connector. Name it Cellarion and paste this address:',
              )}
            </p>
            {address}
          </>
        ),
      }
      : {
        id: 'add',
        title: t('connectClaude.steps.add.title', 'Add Cellarion to Claude'),
        body: t(
          'connectClaude.steps.add.bodyManual',
          'In Claude, open Customize → Connectors, click + Add and choose Add custom connector. Name it Cellarion, paste the address below and click Add.',
        ),
        extra: (
          <>
            {address}
            <p className="connect-ai-note">
              {t(
                'connectClaude.steps.add.selfHostNote',
                'Claude connects to this address from the internet, so it only works if this Cellarion server can be reached from outside your home or office network.',
              )}
            </p>
          </>
        ),
      },
    {
      id: 'approve',
      title: t('connectClaude.steps.approve.title', 'Sign in and choose what Claude may do'),
      body: t(
        'connectClaude.steps.approve.body',
        'Claude takes you to a Cellarion page. Sign in, pick an access level and click Approve. Not sure which level? Start with Read only: Claude can look but never change anything. You can connect again with more access later.',
      ),
    },
    {
      id: 'chat',
      title: t('connectClaude.steps.chat.title', 'Start chatting'),
      body: t(
        'connectClaude.steps.chat.body',
        'Open a new chat in Claude and ask about your cellar. If Claude does not seem to know about it, click + at the bottom of the chat, choose Connectors and check that Cellarion is switched on.',
      ),
    },
  ];

  // The consent screen's own wording, so the guide says exactly what the
  // user is asked to approve (ConnectAiAuthorize.js LEVEL_LABELS).
  const levels = [
    { id: 'read', text: t('oauthConsent.levelRead', 'Read only — it can look, never change anything') },
    { id: 'consume', text: t('oauthConsent.levelConsume', 'Read + log drinking — it can also mark bottles opened or drunk (reversible)') },
    { id: 'write', text: t('oauthConsent.levelFull', 'Full access — it can also add and edit bottles, racks and cellars') },
  ];

  const faq = [
    {
      id: 'cost',
      q: t('connectClaude.faq.cost.q', 'Does it cost anything?'),
      a: t(
        'connectClaude.faq.cost.a',
        'Not from Cellarion: the connector is free, like everything else here. Claude\'s free plan is enough. Its paid plans give you more usage, but you do not need one to start.',
      ),
    },
    {
      id: 'sees',
      q: t('connectClaude.faq.sees.q', 'What does Claude see?'),
      a: t(
        'connectClaude.faq.sees.a',
        'Your own Cellarion data: your cellars, bottles, ratings, notes and racks, and also things like your wishlist, journal, profile, settings, notifications and support tickets. Never other members\' private data. Claude reads only what a chat needs, and what it reads is handled under your own Claude account and Anthropic\'s terms, like anything else you write in Claude.',
      ),
    },
    {
      id: 'mistakes',
      q: t('connectClaude.faq.mistakes.q', 'What if Claude gets something wrong?'),
      a: t(
        'connectClaude.faq.mistakes.a',
        'Changes Claude makes to your bottles, racks and cellars are listed in Cellarion under Settings → AI & connections → Recent AI activity, where you can undo recent ones. You can also simply tell Claude "undo that". A few things cannot be undone, such as a support ticket Claude sends for you.',
      ),
    },
    {
      id: 'disconnect',
      q: t('connectClaude.faq.disconnect.q', 'How do I disconnect?'),
      a: t(
        'connectClaude.faq.disconnect.a',
        'In Cellarion, open Settings → AI & connections → API tokens and click Revoke next to Claude (AI). That cuts Claude off straight away. Removing Cellarion in Claude under Customize → Connectors only stops Claude from using it; Revoke is what ends the access on Cellarion\'s side.',
      ),
    },
    {
      id: 'chatStays',
      q: t('connectClaude.faq.chatStays.q', 'Is Cellar Chat going away?'),
      a: t(
        'connectClaude.faq.chatStays.a',
        'No. Cellar Chat stays for quick questions right here in the app. Claude is for when you want to go further.',
      ),
    },
    {
      id: 'others',
      q: t('connectClaude.faq.others.q', 'Can I use ChatGPT or another assistant instead?'),
      a: t(
        'connectClaude.faq.others.a',
        'Yes. Cellarion works with any AI assistant that supports connectors. The set-up for other apps is in the full connection guide.',
      ),
    },
  ];

  const pageUrl = `${SITE_URL}/connect-ai/claude`;
  const metaDescription = t(
    'connectClaude.metaDescription',
    'Connect your Cellarion wine cellar to Claude in about five minutes, with a free Claude account. A step-by-step guide for beginners.',
  );
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'HowTo',
        name: title,
        description: intro,
        url: pageUrl,
        step: steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.title, text: s.body })),
      },
      {
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          {
            '@type': 'ListItem',
            position: 2,
            name: t('connectAi.title', 'Connect your AI to your wine cellar'),
            item: `${SITE_URL}/connect-ai`,
          },
          { '@type': 'ListItem', position: 3, name: title, item: pageUrl },
        ],
      },
    ],
  };

  return (
    <div className="connect-ai-page connect-claude-page">
      <SEOHead
        title={`${title} — Cellarion`}
        description={metaDescription}
        path="/connect-ai/claude"
        jsonLd={jsonLd}
      />

      <div className="connect-ai-container">
        <header className="connect-ai-header">
          <p className="connect-claude-eyebrow">
            {t('connectClaude.eyebrow', 'No technical skills needed · about five minutes')}
          </p>
          <h1>{title}</h1>
          <p className="connect-ai-subtitle">{intro}</p>
        </header>

        <section className="connect-ai-section">
          <h2>{t('connectClaude.examplesTitle', 'What you can ask')}</h2>
          <ul className="connect-claude-examples">
            {EXAMPLE_KEYS.map((k) => (
              <li key={k}>{t(`connectClaude.examples.${k}`)}</li>
            ))}
          </ul>
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectClaude.whatTitle', 'What is this, exactly?')}</h2>
          <p>
            {t(
              'connectClaude.whatClaude',
              'Claude is an AI assistant made by Anthropic. You chat with it on claude.ai, in its desktop app or in its phone app.',
            )}
          </p>
          <p>
            {t(
              'connectClaude.whatConnector',
              'A connector is a bridge between Claude and another service. Once you add the Cellarion connector, Claude can look things up in your cellar while you chat, just as you would in the app yourself.',
            )}
          </p>
          <p className="connect-ai-note">
            {t(
              'connectClaude.whatMcp',
              'The technical name for this bridge is MCP (Model Context Protocol). You do not need to know anything about it to use it.',
            )}
          </p>
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectClaude.needTitle', 'What you need')}</h2>
          <ul className="connect-claude-needs">
            <li>
              {t(
                'connectClaude.needAccount',
                'A Claude account. The free plan works: it lets you add one connector of your own, and Cellarion is the only one you need.',
              )}
            </li>
            <li>
              {t(
                'connectClaude.needComputer',
                'A computer for the first set-up. Afterwards Cellarion works in the Claude phone app too.',
              )}
            </li>
            <li>{t('connectClaude.needCellarion', 'Your Cellarion account.')}</li>
          </ul>
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectClaude.stepsTitle', 'Set it up in four steps')}</h2>
          <ol className="connect-claude-steps">
            {steps.map((s) => (
              <li key={s.id} className="connect-claude-step">
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                {s.extra}
              </li>
            ))}
          </ol>
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectClaude.levelsTitle', 'The three access levels')}</h2>
          <ul className="connect-ai-scopes">
            {levels.map((l) => <li key={l.id}>{l.text}</li>)}
          </ul>
        </section>

        <section className="connect-ai-section">
          <h2>{t('connectClaude.faqTitle', 'Good to know')}</h2>
          {faq.map((f) => (
            <div className="connect-claude-faq" key={f.id}>
              <h3>{f.q}</h3>
              <p>{f.a}</p>
            </div>
          ))}
        </section>

        <footer className="connect-ai-footer">
          <p>
            <Link to="/connect-ai">{t('connectClaude.otherAppsLink', 'Set-up for other AI apps, and the technical details')}</Link>
            {' · '}
            <Link to="/privacy">{t('connectAi.privacyLink', 'How your data is handled')}</Link>
          </p>
        </footer>
      </div>
    </div>
  );
}

export default ConnectClaude;
