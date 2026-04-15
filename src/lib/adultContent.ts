import { Category, Media } from '../types';

const ADULT_PATTERNS = [
  /(?:^|\s)18\+/,
  /\+18(?:\s|$)/,
  /\bADULT\b/,
  /\bADULTO\b/,
  /\bADULTOS\b/,
  /\bXXX\b/,
  /\bHOT\b/,
  /\bSEXO\b/,
  /\bSEX\b/,
  /\bPORNO\b/,
];

function normalizeAdultLabel(value?: string | null): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

export function isAdultCategoryTitle(title?: string | null): boolean {
  const normalizedTitle = normalizeAdultLabel(title);
  if (!normalizedTitle) {
    return false;
  }

  return ADULT_PATTERNS.some((pattern) => pattern.test(normalizedTitle));
}

export function isAdultCategory(category?: Pick<Category, 'title'> | null): boolean {
  return isAdultCategoryTitle(category?.title);
}

export function isAdultMedia(
  media?: Pick<Media, 'id' | 'category'> | null,
  categories: Category[] = [],
): boolean {
  if (!media) {
    return false;
  }

  if (isAdultCategoryTitle(media.category)) {
    return true;
  }

  return categories.some(
    (category) => isAdultCategory(category) && category.items.some((item) => item.id === media.id),
  );
}
