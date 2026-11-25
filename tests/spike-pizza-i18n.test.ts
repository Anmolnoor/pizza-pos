// Throwaway spike: the English-only `pizza` namespace resolves under non-English locales.
import assert from 'node:assert/strict';
import { getCachedMessages, loadLocaleMessages } from '../frontend/src/lib/i18n/loader';
import { LANGUAGES } from '../frontend/src/lib/i18n/languages';
import { PizzaSpikeLabel } from '../frontend/src/components/pos/pizza/PizzaSpikeLabel';

// use-intl and react live in frontend/node_modules, which tests/ cannot resolve by bare name.
const React = require('../frontend/node_modules/react');
const { renderToStaticMarkup } = require('../frontend/node_modules/react-dom/server');
const { IntlProvider, useTranslations } = require('../frontend/node_modules/use-intl');

function Probe() {
  const t = useTranslations();
  return React.createElement(
    'p',
    null,
    React.createElement(PizzaSpikeLabel, { name: 'Pepperoni' }),
    ` | ${t('common.save')}`,
  );
}

async function run(): Promise<void> {
  for (const lang of ['en', 'de', 'ar', 'zh-tw'] as const) {
    const messages = await loadLocaleMessages(lang);
    assert.equal(getCachedMessages(lang), messages);
    const errors: unknown[] = [];
    const html = renderToStaticMarkup(
      React.createElement(
        IntlProvider,
        {
          locale: LANGUAGES[lang].locale,
          messages,
          timeZone: 'UTC',
          onError: (e: unknown) => errors.push(e),
        },
        React.createElement(Probe),
      ),
    );
    assert.deepEqual(errors, []);
    assert.ok(html.includes('Build your pizza Half: Pepperoni'), html);
    console.log(`  ok ${lang}: ${html}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
