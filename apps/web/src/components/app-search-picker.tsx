import { useEffect, useState } from 'react';
import { Hash } from 'lucide-react';
import { isValidAppId, normalizeCountry, type AppSelection } from '@/lib/appSelection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface AppSearchPickerProps {
  selection: AppSelection;
  onSelect: (next: AppSelection) => void;
  className?: string;
  compact?: boolean;
}

export function AppSearchPicker({ selection, onSelect, className, compact = false }: AppSearchPickerProps) {
  const [appId, setAppId] = useState(selection.appId);
  const [country, setCountry] = useState(selection.country);

  useEffect(() => {
    setAppId(selection.appId);
    setCountry(selection.country);
  }, [selection.appId, selection.country]);

  const applySelection = () => {
    if (!isValidAppId(appId.trim())) {
      return;
    }

    onSelect({
      appId: appId.trim(),
      country: normalizeCountry(country),
    });
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className={cn('grid gap-2', compact ? 'lg:grid-cols-[minmax(0,1fr)_88px_auto]' : 'md:grid-cols-[minmax(0,1fr)_96px_auto]')}>
        <div className="relative">
          <Hash className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="appStoreId"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            autoComplete="off"
            inputMode="numeric"
            spellCheck={false}
            placeholder="App Store ID 예: 123456789"
            className="pl-9"
            aria-label="App Store ID"
          />
        </div>
        <Input
          name="country"
          value={country}
          onChange={(event) => setCountry(event.target.value)}
          autoComplete="off"
          maxLength={2}
          placeholder="국가"
          aria-label="국가 코드"
        />
        <Button type="button" variant="outline" onClick={applySelection}>
          적용
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">App Store ID를 직접 입력하거나 최근 분석된 앱을 선택하세요.</p>
    </div>
  );
}
