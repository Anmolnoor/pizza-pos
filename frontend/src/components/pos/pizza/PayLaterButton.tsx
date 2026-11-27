'use client';

import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import type { PayLaterKind } from '@/lib/pizza/pay-later';

/** "Pay at pickup" / "Pay on delivery", beside Place Order on the pizza cart. */
export function PayLaterButton({
  kind,
  onPress,
  disabled,
}: {
  kind: PayLaterKind;
  onPress: () => void;
  disabled: boolean;
}) {
  const t = useTranslations('pizza');
  return (
    <Button
      variant="outline"
      onClick={() => onPress()}
      disabled={disabled}
      className="flex-1 min-w-0 min-h-12 px-3"
    >
      <span className="truncate">{t(kind === 'pickup' ? 'payAtPickup' : 'payOnDelivery')}</span>
    </Button>
  );
}
