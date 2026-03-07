import { motion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  accentClassName?: string;
}

export function MetricCard({ label, value, hint, icon: Icon, accentClassName }: MetricCardProps) {
  return (
    <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
      <Card className="h-full">
        <CardContent className="flex h-full items-start justify-between gap-4 p-5">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">{label}</p>
            <p className="text-3xl font-semibold tracking-[-0.04em] text-foreground">{value}</p>
            {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
          </div>
          <div className={cn('rounded-2xl border border-border/70 bg-secondary/70 p-3 text-primary', accentClassName)}>
            <Icon className="size-5" />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
