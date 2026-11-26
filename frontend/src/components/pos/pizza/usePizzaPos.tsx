'use client';

import { useEffect, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { customizeOne, replaceCartLine } from '@/lib/pizza/cart-lines';
import { PIZZA_PRODUCT_PREFIX } from '@/lib/pizza/line-recipe';
import { newSheet, sheetReducer, type SheetLine, type SheetState } from '@/lib/pizza/sheet-state';
import type { CartItem, Category, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';
import { HalfAndHalfTile, PIZZA_GRID_CLASS, PizzaCategoryBlocks, PizzaTile } from './PizzaHome';
import PizzaSheet from './PizzaSheet';
import { usePizzaCatalog } from './usePizzaCatalog';

const HALF_AND_HALF = `${PIZZA_PRODUCT_PREFIX}half-and-half`;
const PIZZAS_CATEGORY = 'cat-pizzas';

/** What the POS page, the product grid and the cart panel hook the pizza screens in with. */
export interface PizzaPos {
  /** Takes the place of the product grid's category row. */
  Categories: typeof PizzaCategoryBlocks;
  gridClassName: string;
  /** The tile of a pizza product; null for any other product, which keeps upstream's tile. */
  tile: (
    product: Product,
    inCart: number,
    disabled: boolean,
    fmt: (amount: number) => string,
  ) => ReactNode;
  /** Opens the sheet for a pizza product; false for any other product. */
  open: (product: Product, quantity?: number) => boolean;
  /** True for a cart line the sheet edits. */
  isPizzaLine: (item: CartItem) => boolean;
  /** Opens the sheet on a cart line; false for a line that is not a pizza. */
  edit: (item: CartItem) => boolean;
  /** "Customize 1": takes one off the line and opens the sheet on it. */
  customizeOne: (item: CartItem) => void;
  /** The open sheet, or null. */
  sheet: ReactNode;
}

interface Session {
  initial: SheetState;
  /** The cart line the sheet saves over; null when it adds a new one. */
  lineId: string | null;
  /** The line "Customize 1" split off, merged back when the sheet closes unsaved. */
  split: CartItem | null;
}

/** The pizza screens of the POS page; null when no pizza menu is loaded. */
export function usePizzaPos(
  products: Product[],
  categories: Category[],
  selectCategory: (id: string | null) => void,
): PizzaPos | null {
  const t = useTranslations('pizza');
  const catalog = usePizzaCatalog();
  const [session, setSession] = useState<Session | null>(null);

  // A pizza shop opens on its pizzas.
  const hasPizzas = Boolean(catalog) && categories.some((entry) => entry.id === PIZZAS_CATEGORY);
  useEffect(() => {
    if (hasPizzas) selectCategory(PIZZAS_CATEGORY);
  }, [hasPizzas, selectCategory]);

  if (!catalog) return null;

  const isPizzaLine = (item: CartItem) =>
    item.product.id.startsWith(PIZZA_PRODUCT_PREFIX) && item.recipe?.kind !== 'deal';
  const openSheet = (initial: SheetState, lineId: string | null = null, split?: CartItem) =>
    setSession({ initial, lineId, split: split ?? null });
  const openLine = (line: CartItem, split?: CartItem) =>
    openSheet(sheetReducer(newSheet(), { type: 'load', line }), line.id, split);
  const menuPizza = (product: Product) =>
    catalog.pizzas.find((pizza) => PIZZA_PRODUCT_PREFIX + pizza.id === product.id);
  const sizeOf = (product: Product, variantId: string) => variantId.slice(product.id.length + 1);

  const save = (line: SheetLine, state: SheetState) => {
    const product = products.find((entry) => entry.id === line.productId);
    const variant = product?.variants?.find((entry) => entry.id === line.variantId);
    const onSale = (product?.addon_groups ?? []).flatMap((group) => group.addons ?? []);
    const addons = line.dips.flatMap((dip) => {
      const addon = onSale.find((entry) => entry.id === dip.addonId);
      return addon ? [{ ...addon, quantity: dip.quantity }] : [];
    });
    // The menu was changed in the catalogue since it was loaded: refuse, never add half a pizza.
    if (!product || !variant || addons.length !== line.dips.length) {
      toast.error(t('notOnPos'));
      return;
    }
    const cart = useCartStore.getState();
    const note = state.note.trim();
    const source = cart.items.find((item) => item.id === session?.lineId);
    if (source) {
      useCartStore.setState({
        items: replaceCartLine(cart.items, source.id, {
          product,
          variant,
          quantity: state.quantity,
          addons,
          special_instructions: note,
          ...(source.price_override ? { price_override: source.price_override } : {}),
          ...(line.recipe ? { recipe: line.recipe } : {}),
        }),
      });
    } else {
      cart.addItem(product, state.quantity, addons, note, variant, line.recipe);
    }
    setSession(null);
  };

  const close = () => {
    if (session?.split) {
      const { id, ...line } = session.split;
      useCartStore.setState({
        items: replaceCartLine(useCartStore.getState().items, id, line),
      });
    }
    setSession(null);
  };

  return {
    Categories: PizzaCategoryBlocks,
    gridClassName: PIZZA_GRID_CLASS,
    tile: (product, inCart, disabled, fmt) => {
      if (product.id === HALF_AND_HALF)
        return (
          <HalfAndHalfTile
            key={product.id}
            product={product}
            inCart={inCart}
            disabled={disabled}
            fmt={fmt}
            onSize={(variant) =>
              openSheet(newSheet({ split: true, sizeId: sizeOf(product, variant.id) }))
            }
          />
        );
      const pizza = menuPizza(product);
      if (!pizza) return null;
      return (
        <PizzaTile
          key={product.id}
          product={product}
          number={pizza.number}
          inCart={inCart}
          disabled={disabled}
          fmt={fmt}
          onSize={(variant) => useCartStore.getState().addItem(product, 1, [], '', variant)}
          onCustomize={() => openSheet(newSheet({ pizzaId: pizza.id }))}
        />
      );
    },
    open: (product, quantity = 1) => {
      const pizza = menuPizza(product);
      if (!pizza && product.id !== HALF_AND_HALF) return false;
      openSheet({ ...newSheet({ pizzaId: pizza?.id, split: !pizza }), quantity });
      return true;
    },
    isPizzaLine,
    edit: (item) => {
      if (!isPizzaLine(item)) return false;
      openLine(item);
      return true;
    },
    customizeOne: (item) => {
      const result = customizeOne(useCartStore.getState().items, item.id);
      if (!result) return;
      useCartStore.setState({ items: result.items });
      openLine(result.line, result.line.id === item.id ? undefined : result.line);
    },
    sheet: session && (
      <PizzaSheet
        catalog={catalog}
        initial={session.initial}
        editing={session.lineId !== null}
        onSave={save}
        onClose={close}
      />
    ),
  };
}
