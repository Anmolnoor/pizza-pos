'use client';

import { useTranslations } from 'use-intl';

export function PizzaSpikeLabel({ name }: { name: string }) {
  const t = useTranslations('pizza');
  return (
    <span>
      {t('builderTitle')} {t('halfLabel', { name })}
    </span>
  );
}
