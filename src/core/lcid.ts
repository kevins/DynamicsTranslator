// Language codes used by Dataverse language packs (LCID -> BCP 47 tag).
const TAGS: Record<number, string> = {
  1025: 'ar', 1026: 'bg', 1027: 'ca', 1028: 'zh-TW', 1029: 'cs', 1030: 'da', 1031: 'de', 1032: 'el', 1033: 'en',
  1035: 'fi', 1036: 'fr', 1037: 'he', 1038: 'hu', 1040: 'it', 1041: 'ja', 1042: 'ko', 1043: 'nl', 1044: 'nb',
  1045: 'pl', 1046: 'pt-BR', 1048: 'ro', 1049: 'ru', 1050: 'hr', 1051: 'sk', 1053: 'sv', 1054: 'th', 1055: 'tr',
  1057: 'id', 1058: 'uk', 1060: 'sl', 1061: 'et', 1062: 'lv', 1063: 'lt', 1066: 'vi', 1069: 'eu', 1081: 'hi',
  1086: 'ms', 1087: 'kk', 1110: 'gl', 2052: 'zh-CN', 2070: 'pt-PT', 2074: 'sr-Latn', 3076: 'zh-HK', 3082: 'es',
  3098: 'sr-Cyrl', 1071: 'mk', 1052: 'sq', 1068: 'az', 1079: 'ka', 1091: 'uz', 1106: 'cy', 2108: 'ga', 1039: 'is',
};

/** BCP 47 tag for an LCID ("en" for 1033). Unknown LCIDs return "". */
export const lcidTag = (lcid: number): string => TAGS[lcid] || '';

/** LCID for a BCP 47 tag or a language name prefix; 0 when unknown. */
export function tagLcid(tag: string): number {
  const t = tag.trim().toLowerCase();
  for (const k in TAGS) if (TAGS[k].toLowerCase() === t) return Number(k);
  const base = t.split('-')[0];
  for (const k in TAGS) if (TAGS[k].toLowerCase() === base) return Number(k);
  return 0;
}

let names: Intl.DisplayNames | null | undefined;
/** Display name of a language in the browser's UI language, e.g. 1036 -> "French". */
export function lcidName(lcid: number): string {
  const tag = lcidTag(lcid);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
    } catch {
      names = null;
    }
  }
  let n = '';
  try {
    n = (tag && names?.of(tag)) || '';
  } catch {
    n = '';
  }
  return n ? n.charAt(0).toLocaleUpperCase() + n.slice(1) : tag || String(lcid);
}

/** Short code shown in narrow column headers, e.g. "FR", "PT-BR". */
export const lcidShort = (lcid: number): string => (lcidTag(lcid) || String(lcid)).toUpperCase();

/** Right-to-left languages get dir="rtl" on their inputs. */
export const isRtl = (lcid: number): boolean => lcid === 1025 || lcid === 1037;
