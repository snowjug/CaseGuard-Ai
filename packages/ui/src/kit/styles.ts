/**
 * Griffel (the CSS-in-JS behind `makeStyles`) has no `borderColor` shorthand. This sets the four sides, so a style can
 * change only the colour of a border that another class draws.
 */
export const borderColors = (color: string) =>
  ({
    borderTopColor: color,
    borderRightColor: color,
    borderBottomColor: color,
    borderLeftColor: color,
  }) as const;
