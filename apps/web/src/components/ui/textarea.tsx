import * as React from 'react';
import { cn } from '@/lib/utils';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'flex min-h-28 w-full rounded-md border border-input/80 bg-background/65 px-3 py-2 text-sm text-foreground shadow-xs transition-colors duration-200 outline-none placeholder:text-muted-foreground/85 focus:border-primary/45 focus:bg-background/85 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);

Textarea.displayName = 'Textarea';
