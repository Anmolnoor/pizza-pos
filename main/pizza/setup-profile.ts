/** The `pizza` setup profile: counter-service shop settings and British Columbia tax. It seeds no menu. */
import { createHash } from 'crypto';
import { getDatabase, getSettingValue, now, upsertSettings } from '../db';
import { activateInstalledPack, buildManualPack, persistPackArtifacts } from '../routes/tax-packs';

const SHOP_SETTINGS = {
  service_model: 'qsr',
  tables_required: 'false',
  kds_enabled: 'false',
  server_app_enabled: 'false',
  auto_print_kot: 'true',
  cash_drawer_pulse_enabled: 'true',
  cash_drawer_pulse_methods: '["cash"]',
  kot_show_customer_contact: 'true',
  taxes_enabled: 'true',
};

/**
 * Manual tax configuration, in the shape `POST /api/tax-packs/manual-config` takes. A category's
 * id is its label in lower case, so products carry `food` or `soda` in `tax_category_id`. Both
 * GST components share one label, which is what makes bills and reports add them into one line.
 */
const BC_TAX = {
  inclusive: false,
  categories: [
    { tempId: 'food', label: 'Food', components: [{ label: 'GST', value: '5' }] },
    {
      tempId: 'soda',
      label: 'Soda',
      components: [
        { label: 'GST', value: '5' },
        { label: 'PST', value: '7' },
      ],
    },
  ],
  defaultProductCategoryTempId: 'food',
  packagingCategoryTempId: 'food',
  deliveryCategoryTempId: 'food',
  serviceChargeCategoryTempId: 'food',
};

/** Runs inside the setup transaction, after the owner and the store's country and currency are written. */
export function seedPizzaShop(db: ReturnType<typeof getDatabase>): void {
  upsertSettings(SHOP_SETTINGS);

  const country = String(getSettingValue('country'));
  const pack = buildManualPack(BC_TAX, country, String(getSettingValue('currency')));
  const packJson = JSON.stringify(pack);
  const installedAt = now();
  const version = {
    id: `${pack.id}@${pack.version}`,
    pack_id: pack.id,
    version: pack.version,
    schema_version: 1,
    manifest_json: JSON.stringify({
      id: pack.id,
      publisher: 'local',
      country,
      jurisdiction: '*',
      version: pack.version,
      publishedAt: pack.publishedAt,
    }),
    pack_json: packJson,
    digest: createHash('sha256').update(packJson, 'utf8').digest('hex'),
    signature: null,
    effective_from: pack.effectiveFrom,
    effective_to: null,
    min_flo_version: pack.minFloVersion,
    published_at: pack.publishedAt,
    status: 'installed',
    created_at: installedAt,
  };
  db.prepare(`
    INSERT INTO country_packs (id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at)
    VALUES (?, 'local', ?, '*', NULL, 'installed', ?, ?)
  `).run(pack.id, country, installedAt, installedAt);
  persistPackArtifacts(version, pack, installedAt);

  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string };
  activateInstalledPack(
    db.prepare('SELECT * FROM country_packs WHERE id = ?').get(pack.id) as Parameters<
      typeof activateInstalledPack
    >[0],
    version,
    owner.id,
  );
}
