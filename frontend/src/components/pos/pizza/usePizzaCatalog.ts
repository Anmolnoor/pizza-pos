'use client';

import { useEffect, useSyncExternalStore } from 'react';
import api from '@/lib/api';
import {
  getPizzaCatalog,
  hasPizzaMenu,
  loadPizzaCatalog,
  onPizzaCatalogChange,
  refreshPizzaCatalog,
} from '@/lib/pizza/catalog';
import type { Category, Product } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import type { PizzaCatalog } from '@shared/pizza/types';

/** The catalogue held when it is a pizza menu, which is what switches the pizza screens on. */
const pizzaMenu = () => {
  const held = getPizzaCatalog();
  return hasPizzaMenu(held) ? held : null;
};

/**
 * The shop's pizza menu, or null when it has none or the menu has no pizzas.
 * Fetched when the screen mounts and again when the session's token or tenant
 * changes, which covers a sign-in and a change of tenant; it follows every
 * later change of the catalogue held.
 */
export function usePizzaCatalog(): PizzaCatalog | null {
  const token = useAuthStore((state) => state.token);
  const tenantId = useAuthStore((state) => state.currentTenant?.id);
  useEffect(() => {
    // A failed fetch keeps what is held; the next mount asks again.
    if (token) loadPizzaCatalog().catch(() => {});
  }, [token, tenantId]);
  return useSyncExternalStore(onPizzaCatalogChange, pizzaMenu, () => null);
}

/**
 * Keeps the POS page on the menu the server holds. The catalogue is refreshed
 * when the page mounts, when its window takes the focus or shows again, and
 * when `busy` ends; never while `busy`, so an open sheet keeps the menu it
 * opened on. When a menu the page knew is replaced, the products and categories
 * are fetched again, so the tiles, the prices and the sheet agree.
 */
export function usePizzaMenuRefresh(
  busy: boolean,
  setProducts: (products: Product[]) => void,
  setCategories: (categories: Category[]) => void,
): void {
  useEffect(
    () =>
      onPizzaCatalogChange((replaced) => {
        if (!replaced) return;
        // A failed fetch keeps the lists on screen; the next change asks again.
        api
          .get('/products?active=1')
          .then((response) => setProducts(response.data.products || []))
          .catch(() => {});
        api
          .get('/categories?active=1')
          .then((response) => setCategories(response.data.categories || []))
          .catch(() => {});
      }),
    [setProducts, setCategories],
  );
  useEffect(() => {
    if (busy) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void refreshPizzaCatalog();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [busy]);
}
