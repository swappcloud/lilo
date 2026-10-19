/** Fold search text without changing the displayed spelling or language. */
export function searchText(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}
export function matchesSearch(text: string, query: string): boolean {
  const haystack=searchText(text);
  return searchText(query.trim()).split(/\s+/).filter(Boolean).every((term)=>haystack.includes(term));
}
