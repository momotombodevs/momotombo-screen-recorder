import type { Vec2 } from '@momotombo/project-model';
import { t } from '../../i18n';

/** Spoken name of a spot in the frame on a 3×3 grid ("Abajo a la derecha", "Arriba al centro", …). */
export function placeName(p: Vec2): string {
  const col = p.x < 0.36 ? 0 : p.x > 0.64 ? 2 : 1;
  const row = p.y < 0.36 ? 0 : p.y > 0.64 ? 2 : 1;
  const names = [
    [t("Arriba a la izquierda"), t("Arriba al centro"), t("Arriba a la derecha")],
    [t("Izquierda"), t("Centro"), t("Derecha")],
    [t("Abajo a la izquierda"), t("Abajo al centro"), t("Abajo a la derecha")],
  ];
  return names[row]![col]!;
}

/** Cell centres of the 3×3 position picker, row by row. */
export const PLACE_GRID: Vec2[] = [0.2, 0.5, 0.8].flatMap((y) => [0.12, 0.5, 0.885].map((x) => ({ x, y })));
