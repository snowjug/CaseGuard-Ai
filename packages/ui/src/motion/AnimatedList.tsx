'use client';

import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { AnimatePresence, motion as m } from 'motion/react';
import type { ReactNode } from 'react';
import { motion } from '../tokens/static';
import { useMotionEnabled } from './useMotionEnabled';

const useStyles = makeStyles({
  list: { listStyleType: 'none', margin: 0, padding: 0 },
});

export interface AnimatedListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** `ul` (default) or `ol`. */
  as?: 'ul' | 'ol';
  className?: string;
  itemClassName?: string;
  'aria-label'?: string;
}

/**
 * A list whose items enter, leave and reorder smoothly (200 ms, layout animation only, no bounce). With reduced motion it
 * is a plain list. Items are `li` elements, so the list keeps its semantics.
 */
export function AnimatedList<T>({
  items,
  getKey,
  renderItem,
  as = 'ul',
  className,
  itemClassName,
  'aria-label': ariaLabel,
}: AnimatedListProps<T>) {
  const styles = useStyles();
  const enabled = useMotionEnabled();
  const List = as;
  if (!enabled) {
    return (
      <List role="list" aria-label={ariaLabel} className={mergeClasses(styles.list, className)}>
        {items.map((item, index) => (
          <li key={getKey(item, index)} className={itemClassName}>
            {renderItem(item, index)}
          </li>
        ))}
      </List>
    );
  }
  const MotionList = as === 'ol' ? m.ol : m.ul;
  return (
    <MotionList role="list" aria-label={ariaLabel} className={mergeClasses(styles.list, className)}>
      <AnimatePresence initial={false}>
        {items.map((item, index) => (
          <m.li
            key={getKey(item, index)}
            className={itemClassName}
            layout="position"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: motion.base / 1000, ease: motion.curve }}
          >
            {renderItem(item, index)}
          </m.li>
        ))}
      </AnimatePresence>
    </MotionList>
  );
}
