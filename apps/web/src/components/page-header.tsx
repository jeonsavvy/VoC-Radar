import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  status?: string;
  meta?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, status, meta, actions, className }: PageHeaderProps) {
  return (
    <section className={cn('relative overflow-hidden rounded-[1.75rem] border border-border/70 bg-card/85 p-6 shadow-sm backdrop-blur-xl sm:p-8', className)}>
      <div className="surface-grid absolute inset-0 rounded-[1.75rem]" aria-hidden="true" />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-xs uppercase tracking-[0.24em] text-muted-foreground">
            <span>{eyebrow}</span>
            {status ? <Badge variant="outline">{status}</Badge> : null}
            {meta ? <span>{meta}</span> : null}
          </div>
          <div className="space-y-3">
            <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl lg:text-[3.2rem]">
              {title}
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">{description}</p>
          </div>
        </div>

        {actions ? <div className="relative z-10 flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
      <div className="pointer-events-none absolute -right-12 top-8 hidden size-36 rounded-full border border-primary/15 bg-primary/10 blur-3xl lg:block" />
      <ArrowUpRight className="pointer-events-none absolute bottom-6 right-6 hidden size-5 text-muted-foreground/50 lg:block" />
    </section>
  );
}
