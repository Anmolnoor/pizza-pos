/**
 * The lists a screen shows beside the pizza menu, which are the POS page's
 * products and categories: fetched again after the menu changed, for the
 * session and tenant that asked, until each has answered.
 */
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { getSessionBoundaryEpoch } from '@/store/session-events';

export interface MenuList {
  url: string;
  /** Takes the route's answer; not called for an answer that came for another session or tenant. */
  apply: (data: never) => void;
}

/** Who a request is for: the tenant, and the session as its boundaries count it. */
const asker = () =>
  `${useAuthStore.getState().currentTenant?.id ?? ''}:${getSessionBoundaryEpoch()}`;

/**
 * `markAll()` says every list is out of date. `run()` fetches each list that
 * still is and has no request on its way. A list whose fetch fails, or whose
 * answer arrives after the tenant or the session changed, stays out of date,
 * so the next `run()` asks for it again.
 */
export function menuListSync(lists: MenuList[]) {
  const stale = new Set<MenuList>();
  const asking = new Set<MenuList>();
  return {
    markAll: () => lists.forEach((list) => stale.add(list)),
    run: async (): Promise<void> => {
      await Promise.all(
        lists
          .filter((list) => stale.has(list) && !asking.has(list))
          .map(async (list) => {
            const askedBy = asker();
            asking.add(list);
            try {
              const { data } = await api.get(list.url);
              if (askedBy !== asker()) return;
              stale.delete(list);
              list.apply(data as never);
            } catch {
              // Still out of date; the next run asks again.
            } finally {
              asking.delete(list);
            }
          }),
      );
    },
  };
}
