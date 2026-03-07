import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(({ className, ...props }, ref) => {
  return (
    <input
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-md border border-input/80 bg-background/65 px-3 py-2 text-sm text-foreground shadow-xs transition-colors duration-200 outline-none placeholder:text-muted-foreground/85 focus:border-primary/45 focus:bg-background/85 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});

Input.displayName = 'Input';
