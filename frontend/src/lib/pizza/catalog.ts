/** The pizza menu the server holds, fetched once and kept for the session. */
import api from '@/lib/api';
import type { PizzaCatalog } from '../../../../shared/pizza/types';

let catalog: PizzaCatalog | null = null;
let request: Promise<PizzaCatalog | null> | null = null;

/** The catalogue held now: null before it has loaded, and when the shop has no pizza menu. */
export function getPizzaCatalog(): PizzaCatalog | null {
  return catalog;
}

/** Fetches the catalogue again. A 404 means no pizza menu is loaded, and answers null. */
export function reloadPizzaCatalog(): Promise<PizzaCatalog | null> {
  const fetching: Promise<PizzaCatalog | null> = api.get<PizzaCatalog>('/pizza/catalog').then(
    (response) => (catalog = response.data),
    (error) => {
      if (error?.response?.status === 404) return (catalog = null);
      // What is held stays, and the next load asks again.
      if (request === fetching) request = null;
      throw error;
    },
  );
  request = fetching;
  return fetching;
}

/** Fetches the catalogue the first time; every later call answers that same fetch. */
export function loadPizzaCatalog(): Promise<PizzaCatalog | null> {
  return request ?? reloadPizzaCatalog();
}
