'use client';

import { useEffect, useState } from 'react';
import { getPizzaCatalog, loadPizzaCatalog } from '@/lib/pizza/catalog';
import { useAuthStore } from '@/store/auth';
import type { PizzaCatalog } from '@shared/pizza/types';

/**
 * The shop's pizza menu, or null when it has none. Fetched when the screen
 * mounts and again after a sign-in, which clears what was held.
 */
export function usePizzaCatalog(): PizzaCatalog | null {
  const token = useAuthStore((state) => state.token);
  const [catalog, setCatalog] = useState(getPizzaCatalog);
  useEffect(() => {
    let current = true;
    (token ? loadPizzaCatalog() : Promise.resolve(null)).then(
      (loaded) => {
        if (current) setCatalog(loaded);
      },
      // A failed fetch keeps what is held; the next mount asks again.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [token]);
  return catalog;
}
