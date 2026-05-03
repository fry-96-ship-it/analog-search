import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { API_BASE } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  Search,
  Download,
  Loader2,
  ClipboardList,
  Sparkles,
  Layers,
  Zap,
  X,
  Globe,
  Bot,
  ArrowLeft,
  CopyCheck,
  Network,
} from "lucide-react";
import type {
  MaterialInput,
  ListAnalysisResult,
  ListAnalysisMode,
  AnalogGroup,
  SimilarityPair,
} from "@shared/schema";
import { getGroupColor } from "@shared/group-colors";

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function levelStyle(lvl: string) {
  if (lvl === "duplicate")
    return {
      label: "Дубликат",
      cls: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30",
    };
  if (lvl === "likely")
    return {
      label: "Аналог",
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    };
  return {
    label: "Заменитель",
    cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  };
}

export default function ListAnalysis() {
  const { toast } = useToast();

  const [items, setItems] = useState<MaterialInput[]>([]);
  const [manualText, setManualText] = useState("");
  const [mode, setMode] = useState<ListAnalysisMode>("fast");
  const [threshold, setThreshold] = useState(0.55);
  const [result, setResult] = useState<ListAnalysisResult | null>(null);
  const [inProgress, setInProgress] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<AnalogGroup | null>(null);

  // Поиск аналогов одной позиции
  const [analogTarget, setAnalogTarget] = useState<MaterialInput | null>(null);
  const [analogPairs, setAnalogPairs] = useState<SimilarityPair[] | null>(null);
  const [analogLoading, setAnalogLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const itemById = useMemo(() => {
    const m = new Map<string, MaterialInput>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  function addFromManualText() {
    const lines = manualText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const newItems: MaterialInput[] = lines.map((line) => {
      const parts = line.split(/\t|;/);
      if (parts.length >= 2) {
        return {
          id: genId(),
          code: parts[0].trim(),
          name: parts.slice(1).join(" ").trim(),
        };
      }
      return { id: genId(), name: line };
    });
    setItems((prev) => [...prev, ...newItems]);
    setManualText("");
    toast({ title: `Добавлено позиций: ${newItems.length}` });
  }

  async function handleFileUpload(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`${API_BASE}/api/parse-file`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Ошибка" }));
        throw new Error(err.message || "Ошибка загрузки файла");
      }
      const { items: parsed } = (await res.json()) as {
        items: { code?: string; name: string }[];
      };
      const mapped: MaterialInput[] = parsed.map((p) => ({
        id: genId(),
        name: p.name,
        code: p.code,
      }));
      setItems((prev) => [...prev, ...mapped]);
      toast({ title: `Загружено позиций: ${mapped.length}` });
    } catch (err: any) {
      toast({
        title: "Ошибка",
        description: err.message || String(err),
        variant: "destructive",
      });
    } finally {
      if (ev.target) ev.target.value = "";
    }
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  function clearAll() {
    setItems([]);
    setResult(null);
    setAnalogTarget(null);
    setAnalogPairs(null);
  }

  async function runAnalysis() {
    if (items.length < 2) {
      toast({
        title: "Добавьте минимум 2 позиции",
        variant: "destructive",
      });
      return;
    }
    setInProgress(true);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/analyze-list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, mode, threshold }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Ошибка" }));
        throw new Error(err.message || "Ошибка анализа");
      }
      const data = (await res.json()) as ListAnalysisResult;
      setResult(data);
      toast({
        title: "Анализ завершён",
        description: `Групп: ${data.groups.length}, пар: ${data.pairs.length}`,
      });
    } catch (err: any) {
      toast({
        title: "Ошибка",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setInProgress(false);
    }
  }

  async function findAnalogsForOne(target: MaterialInput) {
    setAnalogTarget(target);
    setAnalogPairs(null);
    setAnalogLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/find-analogs-in-list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          targetId: target.id,
          threshold: 0.4,
          limit: 20,
        }),
      });
      if (!res.ok) throw new Error("Ошибка поиска");
      const data = (await res.json()) as { pairs: SimilarityPair[] };
      setAnalogPairs(data.pairs);
    } catch (err: any) {
      toast({
        title: "Ошибка",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setAnalogLoading(false);
    }
  }

  async function exportXlsx() {
    if (!result) {
      toast({ title: "Сначала выполните анализ", variant: "destructive" });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/export-list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, result }),
      });
      if (!res.ok) throw new Error("Ошибка экспорта");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `list-analysis-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({
        title: "Ошибка",
        description: err.message,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/50">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <Network className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight truncate">
                Анализ списка: дубликаты и аналоги внутри номенклатуры
              </h1>
              <p className="text-xs text-muted-foreground">
                Найдём похожие и взаимозаменяемые позиции прямо в вашем списке
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link href="/">
              <Button variant="ghost" size="sm" data-testid="button-go-home">
                <ArrowLeft className="w-4 h-4 mr-2" />
                К поиску в интернете
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={exportXlsx}
              disabled={!result}
              data-testid="button-export-list"
            >
              <Download className="w-4 h-4 mr-2" />
              Экспорт в Excel
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        {/* Левая колонка */}
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-primary" />
                Список номенклатуры
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="manual">
                <TabsList className="grid grid-cols-2 w-full">
                  <TabsTrigger value="manual" data-testid="tab-manual">
                    Ввод
                  </TabsTrigger>
                  <TabsTrigger value="upload" data-testid="tab-upload">
                    Файл
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="manual" className="mt-3 space-y-2">
                  <Label
                    htmlFor="manual-text"
                    className="text-xs text-muted-foreground"
                  >
                    Одна позиция в строке. Формат: <span className="font-mono">код [Tab] наименование</span> (или просто наименование).
                  </Label>
                  <Textarea
                    id="manual-text"
                    data-testid="input-manual-text"
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    rows={6}
                    placeholder={
                      "00012345\tПодшипник 6204 2RS\n00012346\tПодшипник 6204-2RS SKF\n00098765\tМасло моторное 5W-40\n00098766\tМасло 5W40 синтетика"
                    }
                    className="font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    onClick={addFromManualText}
                    data-testid="button-add-manual"
                    className="w-full"
                  >
                    Добавить
                  </Button>
                </TabsContent>
                <TabsContent value="upload" className="mt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Excel (.xlsx, .xls) или CSV. Колонка с наименованием
                    распознается автоматически.
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="button-upload-list"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    Выбрать файл со списком
                  </Button>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary" />
                Параметры анализа
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Режим работы
                </Label>
                <Select
                  value={mode}
                  onValueChange={(v) => setMode(v as ListAnalysisMode)}
                >
                  <SelectTrigger data-testid="select-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fast">
                      <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-amber-500" />
                        <div>
                          <div className="text-sm">Быстрый алгоритм</div>
                          <div className="text-xs text-muted-foreground">
                            Без AI, мгновенно
                          </div>
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="hybrid">
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-violet-500" />
                        <div>
                          <div className="text-sm">Гибридный</div>
                          <div className="text-xs text-muted-foreground">
                            Алгоритм + проверка AI
                          </div>
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="ai">
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4 text-emerald-500" />
                        <div>
                          <div className="text-sm">Только AI</div>
                          <div className="text-xs text-muted-foreground">
                            До 60 позиций
                          </div>
                        </div>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {mode === "fast" &&
                    "Сравнивает наименования по словам, n-граммам и числовым параметрам. Бесплатно, работает за секунды."}
                  {mode === "hybrid" &&
                    "Сначала отбирает кандидатов алгоритмом, затем GigaChat подтверждает или отклоняет каждую пару с обоснованием. Самый точный режим для больших списков."}
                  {mode === "ai" &&
                    "GigaChat сам анализирует весь список целиком. Лучше всего для коротких списков. Для списков >60 позиций автоматически переключается на гибридный режим."}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">
                    Порог схожести
                  </Label>
                  <Badge variant="secondary" className="text-xs">
                    {Math.round(threshold * 100)}%
                  </Badge>
                </div>
                <Slider
                  value={[threshold]}
                  onValueChange={(v) => setThreshold(v[0])}
                  min={0.3}
                  max={0.9}
                  step={0.05}
                  data-testid="slider-threshold"
                />
                <p className="text-xs text-muted-foreground">
                  Чем выше порог, тем строже критерий. Рекомендуем 55%.
                </p>
              </div>
            </CardContent>
          </Card>

          {items.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span>Позиции в списке</span>
                  <Badge variant="secondary">{items.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 max-h-72 overflow-y-auto">
                {items.map((it) => (
                  <div
                    key={it.id}
                    className="flex items-start justify-between gap-2 p-2 rounded-md border border-border hover-elevate text-sm"
                    data-testid={`item-${it.id}`}
                  >
                    <button
                      className="flex-1 min-w-0 text-left"
                      onClick={() => findAnalogsForOne(it)}
                      title="Найти аналоги именно для этой позиции"
                      data-testid={`button-find-${it.id}`}
                    >
                      {it.code && (
                        <div className="text-xs text-muted-foreground font-mono">
                          {it.code}
                        </div>
                      )}
                      <div className="truncate" title={it.name}>
                        {it.name}
                      </div>
                    </button>
                    <button
                      onClick={() => removeItem(it.id)}
                      className="text-muted-foreground hover:text-destructive p-1"
                      data-testid={`button-remove-${it.id}`}
                      aria-label="Удалить"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={runAnalysis}
              disabled={inProgress || items.length < 2}
              data-testid="button-analyze-list"
            >
              {inProgress ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Анализ…
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  Проанализировать список
                </>
              )}
            </Button>
            {(items.length > 0 || result) && !inProgress && (
              <Button
                variant="outline"
                onClick={clearAll}
                data-testid="button-clear"
              >
                Очистить
              </Button>
            )}
          </div>
        </aside>

        {/* Правая колонка */}
        <section className="space-y-4 min-w-0">
          {!result && !inProgress && !analogTarget && (
            <Card>
              <CardContent className="pt-10 pb-10 text-center space-y-3">
                <div className="w-14 h-14 rounded-full bg-primary/10 mx-auto flex items-center justify-center">
                  <CopyCheck className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-base font-semibold">
                    Готово к анализу
                  </h2>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto">
                    Загрузите список номенклатуры и выберите режим. Программа
                    найдёт дубликаты, аналоги и заменители прямо внутри вашего
                    списка — без поиска в интернете.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {inProgress && (
            <Card>
              <CardContent className="pt-6 pb-6 space-y-3 text-center">
                <Loader2 className="w-8 h-8 mx-auto text-primary animate-spin" />
                <div className="text-sm font-medium">
                  {mode === "fast" && "Сравниваем позиции…"}
                  {mode === "hybrid" &&
                    "Алгоритм отобрал кандидатов, GigaChat проверяет каждую пару…"}
                  {mode === "ai" && "GigaChat анализирует список…"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Для списка из {items.length} позиций
                </div>
              </CardContent>
            </Card>
          )}

          {result && (
            <>
              {/* Статистика */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <StatCard label="Всего позиций" value={result.stats.total} />
                <StatCard
                  label="В группах"
                  value={result.stats.grouped}
                  accent="text-primary"
                />
                <StatCard
                  label="Дубликатов"
                  value={result.stats.duplicates}
                  accent="text-rose-600 dark:text-rose-400"
                />
                <StatCard
                  label="Аналогов"
                  value={result.stats.likely}
                  accent="text-emerald-600 dark:text-emerald-400"
                />
                <StatCard
                  label="Заменителей"
                  value={result.stats.possible}
                  accent="text-sky-600 dark:text-sky-400"
                />
              </div>

              {/* Группы */}
              {result.groups.length === 0 ? (
                <Card>
                  <CardContent className="pt-8 pb-8 text-center">
                    <div className="text-sm font-medium">
                      Похожих позиций не найдено
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Попробуйте снизить порог схожести или сменить режим.
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {result.groups.map((g, idx) => {
                    const lvl = levelStyle(g.matchLevel);
                    return (
                      <Card
                        key={g.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => setSelectedGroup(g)}
                        data-testid={`card-group-${g.id}`}
                      >
                        <CardContent className="pt-4 pb-4 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs">
                                Группа {idx + 1}
                              </Badge>
                              <Badge
                                variant="outline"
                                className={lvl.cls}
                              >
                                {lvl.label}
                              </Badge>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {Math.round(g.avgSimilarity * 100)}% схожесть
                            </span>
                          </div>
                          <div
                            className="font-medium text-sm line-clamp-2"
                            title={g.representative}
                          >
                            {g.representative}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {g.itemIds.length} похожих позиций
                          </div>
                          <div className="space-y-1 pt-1">
                            {g.itemIds.slice(0, 3).map((id) => {
                              const it = itemById.get(id);
                              return (
                                <div
                                  key={id}
                                  className="text-xs text-muted-foreground truncate pl-2 border-l-2 border-border"
                                  title={it?.name}
                                >
                                  {it?.name}
                                </div>
                              );
                            })}
                            {g.itemIds.length > 3 && (
                              <div className="text-xs text-muted-foreground pl-2">
                                ещё {g.itemIds.length - 3}…
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}

              {/* Таблица всех позиций с группами */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    Полный список с группами
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12">№</TableHead>
                          <TableHead className="w-[140px]">Код</TableHead>
                          <TableHead className="min-w-[280px]">
                            Наименование
                          </TableHead>
                          <TableHead>Группа</TableHead>
                          <TableHead>Тип</TableHead>
                          <TableHead>Действие</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((it, idx) => {
                          const groupIdx = result.groups.findIndex((g) =>
                            g.itemIds.includes(it.id),
                          );
                          const group =
                            groupIdx >= 0 ? result.groups[groupIdx] : null;
                          const lvl = group
                            ? levelStyle(group.matchLevel)
                            : null;
                          const color = getGroupColor(groupIdx);
                          return (
                            <TableRow
                              key={it.id}
                              className={group ? color.bgClass : ""}
                              data-testid={`row-item-${it.id}`}
                            >
                              <TableCell className="align-top text-xs text-muted-foreground tabular-nums">
                                {idx + 1}
                              </TableCell>
                              <TableCell className="align-top text-xs font-mono">
                                {it.code || (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="align-top">
                                <div
                                  className="text-sm font-medium max-w-[420px] truncate"
                                  title={it.name}
                                >
                                  {it.name}
                                </div>
                              </TableCell>
                              <TableCell className="align-top">
                                {group ? (
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`inline-block w-2.5 h-2.5 rounded-full ${color.dotClass}`}
                                      aria-hidden
                                    />
                                    <Badge variant="outline" className="text-xs">
                                      Группа {groupIdx + 1}
                                    </Badge>
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="align-top">
                                {lvl && (
                                  <Badge
                                    variant="outline"
                                    className={lvl.cls}
                                  >
                                    {lvl.label}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="align-top">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => findAnalogsForOne(it)}
                                  data-testid={`button-find-row-${it.id}`}
                                >
                                  <Search className="w-3.5 h-3.5 mr-1" />
                                  Аналоги
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </section>
      </main>

      {/* Диалог группы */}
      <Dialog
        open={!!selectedGroup}
        onOpenChange={(o) => !o && setSelectedGroup(null)}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          {selectedGroup && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg">
                  {selectedGroup.representative}
                </DialogTitle>
                <DialogDescription className="text-sm">
                  <Badge
                    variant="outline"
                    className={levelStyle(selectedGroup.matchLevel).cls}
                  >
                    {levelStyle(selectedGroup.matchLevel).label}
                  </Badge>
                  <span className="ml-2 text-muted-foreground">
                    {selectedGroup.itemIds.length} позиций · средняя схожесть{" "}
                    {Math.round(selectedGroup.avgSimilarity * 100)}%
                  </span>
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 mt-4">
                {selectedGroup.itemIds.map((id) => {
                  const it = itemById.get(id);
                  if (!it) return null;
                  return (
                    <div
                      key={id}
                      className="border border-border rounded-md p-3"
                    >
                      {it.code && (
                        <div className="text-xs text-muted-foreground font-mono">
                          {it.code}
                        </div>
                      )}
                      <div className="text-sm">{it.name}</div>
                    </div>
                  );
                })}
              </div>
              {result && (
                <div className="mt-4">
                  <h3 className="text-sm font-semibold mb-2">
                    Связи внутри группы
                  </h3>
                  <div className="space-y-1.5">
                    {result.pairs
                      .filter(
                        (p) =>
                          selectedGroup.itemIds.includes(p.aId) &&
                          selectedGroup.itemIds.includes(p.bId),
                      )
                      .map((p, i) => (
                        <div
                          key={i}
                          className="text-xs border border-border rounded-md px-3 py-2 space-y-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">
                              {Math.round(p.similarity * 100)}% ·{" "}
                              {levelStyle(p.matchLevel).label}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">A: </span>
                            {itemById.get(p.aId)?.name}
                          </div>
                          <div>
                            <span className="text-muted-foreground">B: </span>
                            {itemById.get(p.bId)?.name}
                          </div>
                          {p.reason && (
                            <div className="pt-1 italic text-muted-foreground">
                              {p.reason}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Диалог "аналоги конкретной позиции" */}
      <Dialog
        open={!!analogTarget}
        onOpenChange={(o) => {
          if (!o) {
            setAnalogTarget(null);
            setAnalogPairs(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          {analogTarget && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg">
                  Аналоги для позиции
                </DialogTitle>
                <DialogDescription>
                  {analogTarget.code && (
                    <span className="font-mono text-xs mr-2">
                      {analogTarget.code}
                    </span>
                  )}
                  {analogTarget.name}
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4">
                {analogLoading ? (
                  <div className="text-center py-6">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" />
                    <div className="text-sm text-muted-foreground mt-2">
                      Ищем похожие позиции…
                    </div>
                  </div>
                ) : analogPairs && analogPairs.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-6">
                    Похожих позиций в списке не найдено.
                  </div>
                ) : analogPairs ? (
                  <div className="space-y-2">
                    {analogPairs.map((p, i) => {
                      const other = itemById.get(
                        p.aId === analogTarget.id ? p.bId : p.aId,
                      );
                      if (!other) return null;
                      const lvl = levelStyle(p.matchLevel);
                      return (
                        <div
                          key={i}
                          className="border border-border rounded-md p-3 space-y-1"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              {other.code && (
                                <div className="text-xs text-muted-foreground font-mono">
                                  {other.code}
                                </div>
                              )}
                              <div className="text-sm font-medium">
                                {other.name}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Badge variant="outline" className={lvl.cls}>
                                {lvl.label}
                              </Badge>
                              <Badge variant="secondary" className="text-xs">
                                {Math.round(p.similarity * 100)}%
                              </Badge>
                            </div>
                          </div>
                          {p.reason && (
                            <div className="text-xs text-muted-foreground italic">
                              {p.reason}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4 text-center">
        <div className={`text-2xl font-semibold ${accent || ""}`}>{value}</div>
        <div className="text-xs text-muted-foreground mt-1">{label}</div>
      </CardContent>
    </Card>
  );
}
