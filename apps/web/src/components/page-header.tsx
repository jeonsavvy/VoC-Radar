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
    <section className={cn('rounded-[1.25rem] border border-border bg-card p-6 shadow-sm sm:p-7', className)}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-muted-foreground">
            <span>{eyebrow}</span>
            {status ? <Badge variant="outline">{status}</Badge> : null}
            {meta ? <span>{meta}</span> : null}
          </div>
          <div className="space-y-3">
            <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">
              {title}
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">{description}</p>
          </div>
        </div>

        {actions ? <div className="relative z-10 flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
    </section>
  );
}
