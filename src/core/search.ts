// The one search of every search box (All labels on this page, the Workbench's Filter rows and Filter entities): every
// word typed, in any order, with case, accents, apostrophes and ligatures aside, so "tele" finds Téléphone and
// Télécopie and "l'action" finds "Symbole de l’action".

/**
 * Text as the searches compare it: lower case, without accents or other marks (Arabic and Hebrew vowel signs too),
 * compatibility forms as their plain letters (full-width ＩＤ, the ﬁ ligature), typographic apostrophes as ', letters
 * that don't decompose as their base letter (ı ł ø đ ħ, a final ς as σ), ligatures spelled out (œ, æ, ß), soft hyphens
 * and zero-width characters dropped, `_` and dashes as spaces ("ecole name" finds "École_Name").
 */
export const fold = (t: string): string =>
  t
    .replace(/[­​-‍⁠﻿]/g, '')
    .replace(/[’‘ʼ´`]/g, "'") // before NFKD, which turns ´ into a space and a mark
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/ı/g, 'i')
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/đ/g, 'd')
    .replace(/ħ/g, 'h')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/[_\p{Pd}]/gu, ' ');

/** The words of a search box, folded. */
export const terms = (q: string): string[] => fold(q).split(/\s+/).filter(Boolean);

/** Every word occurs in the (folded) text. */
export const hit = (text: string, t: readonly string[]): boolean => t.every((x) => text.includes(x));
