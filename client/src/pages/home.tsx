import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { API_BASE } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  Search,
  FileSpreadsheet,
  Download,
  Loader2,
  Factory,
  ClipboardList,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  X,
  BookOpen,
  Network,
} from "lucide-react";
import type { AnalysisResult, MaterialInput } from "@shared/schema";

type CatalogItem = { code?: string; name: string };

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function matchLevelLabel(lvl: string) {
  if (lvl === "full") return { label: "Полный аналог", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" };
  if (lvl === "partial") return { label: "Частичный", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" };
  return { label: "Заменитель", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30" };
}

export default function Home() {
  const { toast } = useToast();

  const [items, setItems] = useState<MaterialInput[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [manualText, setManualText] = useState("");
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [inProgress, setInProgress] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [selectedResult, setSelectedResult] = useState<AnalysisResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const catalogInputRef = useRef<HTMLInputElement>(null);

  const done = results.filter((r) => r.status === "done" || r.status === "error").length;
  const total = progress.total;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  function addFromManualText() {
    const lines = manualText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const newItems: MaterialInput[] = lines.map((line) => {
      // Формат: "КОД\tНаименование" или "КОД Наименование" или просто наименование
      const parts = line.split(/\t|;/);
      if (parts.length >= 2) {
        return { id: genId(), code: parts[0].trim(), name: parts.slice(1).join(" ").trim() };
      }
      return { id: genId(), name: line };
    });
    setItems((prev) => [...prev, ...newItems]);
    setManualText("");
    toast({ title: `Добавлено позиций: ${newItems.length}` });
  }

  async function handleFileUpload(
    ev: React.ChangeEvent<HTMLInputElement>,
    target: "items" | "catalog"
  ) {
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
        items: CatalogItem[];
      };
      if (target === "items") {
        const mapped: MaterialInput[] = parsed.map((p) => ({
          id: genId(),
          name: p.name,
          code: p.code,
        }));
        setItems((prev) => [...prev, ...mapped]);
        toast({ title: `Загружено позиций: ${mapped.length}` });
      } else {
        setCatalog((prev) => [...prev, ...parsed]);
        toast({ title: `Добавлено в справочник: ${parsed.length}` });
      }
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
    setResults([]);
    setProgress({ done: 0, total: 0 });
  }

  async function runAnalysis() {
    if (items.length === 0) {
      toast({ title: "Добавьте хотя бы одну позицию", variant: "destructive" });
      return;
    }
    setInProgress(true);
    setResults([]);
    setProgress({ done: 0, total: items.length });

    try {
      const res = await fetch(`${API_BASE}/api/analyze-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, catalog }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => "");
        throw new Error(t || "Сервер не ответил");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          const ev = lines.find((l) => l.startsWith("event: "))?.slice(7).trim();
          const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
          if (!ev || !data) continue;
          const payload = JSON.parse(data);
          if (ev === "result") {
            setResults((prev) => [...prev, payload as AnalysisResult]);
          } else if (ev === "done") {
            toast({ title: "Готово", description: `Обработано: ${payload.count}` });
          } else if (ev === "error") {
            toast({ title: "Ошибка анализа", description: payload.message, variant: "destructive" });
          }
        }
      }
    } catch (err: any) {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    } finally {
      setInProgress(false);
    }
  }

  async function exportXlsx() {
    if (results.length === 0) {
      toast({ title: "Нет результатов для экспорта", variant: "destructive" });
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results }),
      });
      if (!res.ok) throw new Error("Ошибка экспорта");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `analogs-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Ошибка", description: err.message, variant: "destructive" });
    }
  }

  // Сводная таблица
  const tableRows = useMemo(() => {
    return results.flatMap((r) =>
      r.analogs.length === 0
        ? [{ r, a: null as any }]
        : r.analogs.map((a) => ({ r, a }))
    );
  }, [results]);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
              <svg viewBox="0 0 32 32" className="w-6 h-6 text-primary" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-label="Логотип">
                <rect x="4" y="6" width="10" height="10" rx="1.5" />
                <rect x="18" y="16" width="10" height="10" rx="1.5" />
                <path d="M14 11h4M14 21h4M21 11v5" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Поиск аналогов номенклатуры</h1>
              <p className="text-xs text-muted-foreground">Анализ позиций, характеристики, аналоги и сопоставление со справочником</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/list-analysis">
              <Button variant="ghost" size="sm" data-testid="button-go-list-analysis">
                <Network className="w-4 h-4 mr-2" />
                Анализ списка
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={exportXlsx}
              disabled={results.length === 0}
              data-testid="button-export"
            >
              <Download className="w-4 h-4 mr-2" />
              Экспорт в Excel
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-6">
        {/* Левая колонка — ввод */}
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-primary" />
                Список материалов
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="manual">
                <TabsList className="grid grid-cols-2 w-full">
                  <TabsTrigger value="manual" data-testid="tab-manual">Ввод</TabsTrigger>
                  <TabsTrigger value="upload" data-testid="tab-upload">Файл</TabsTrigger>
                </TabsList>
                <TabsContent value="manual" className="mt-3 space-y-2">
                  <Label htmlFor="manual-text" className="text-xs text-muted-foreground">
                    Одна позиция в строке. Можно через Tab разделять код и наименование.
                  </Label>
                  <Textarea
                    id="manual-text"
                    data-testid="input-manual-text"
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    rows={5}
                    placeholder="Подшипник 6204 2RS&#10;Масло моторное 5W-40 синтетика&#10;Перчатки нитриловые XL"
                    className="font-mono text-xs"
                  />
                  <Button size="sm" onClick={addFromManualText} data-testid="button-add-manual" className="w-full">
                    Добавить
                  </Button>
                </TabsContent>
                <TabsContent value="upload" className="mt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Excel (.xlsx, .xls) или CSV. Колонка с наименованием распознается автоматически.
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => handleFileUpload(e, "items")}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => fileInputRef.current?.click()}
                    data-testid="button-upload-items"
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
                <BookOpen className="w-4 h-4 text-primary" />
                Внутренний справочник
                {catalog.length > 0 && (
                  <Badge variant="secondary" className="ml-auto">
                    {catalog.length}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Необязательно. Если загрузить — найденные аналоги будут сопоставлены с позициями из вашего справочника.
              </p>
              <input
                ref={catalogInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => handleFileUpload(e, "catalog")}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => catalogInputRef.current?.click()}
                  data-testid="button-upload-catalog"
                >
                  <FileSpreadsheet className="w-4 h-4 mr-2" />
                  {catalog.length > 0 ? "Добавить ещё" : "Загрузить справочник"}
                </Button>
                {catalog.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCatalog([])}
                    data-testid="button-clear-catalog"
                  >
                    Очистить
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {items.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span>Позиции в очереди</span>
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
                    <div className="flex-1 min-w-0">
                      {it.code && (
                        <div className="text-xs text-muted-foreground font-mono">
                          {it.code}
                        </div>
                      )}
                      <div className="truncate" title={it.name}>{it.name}</div>
                    </div>
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
              disabled={inProgress || items.length === 0}
              data-testid="button-analyze"
            >
              {inProgress ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Поиск…
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  Найти аналоги
                </>
              )}
            </Button>
            {(items.length > 0 || results.length > 0) && !inProgress && (
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

        {/* Правая колонка — результаты */}
        <section className="space-y-4 min-w-0">
          {inProgress && (
            <Card>
              <CardContent className="pt-6 pb-5 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Sparkles className="w-4 h-4 text-primary" />
                    Идёт поиск и подбор аналогов
                  </span>
                  <span className="text-muted-foreground">
                    {done} / {total}
                  </span>
                </div>
                <Progress value={pct} />
              </CardContent>
            </Card>
          )}

          {results.length === 0 && !inProgress && (
            <Card>
              <CardContent className="pt-10 pb-10 text-center space-y-3">
                <div className="w-14 h-14 rounded-full bg-primary/10 mx-auto flex items-center justify-center">
                  <Search className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-base font-semibold">Результаты появятся здесь</h2>
                  <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                    Добавьте позиции слева — вручную или загрузкой файла — и нажмите "Найти аналоги". Можно также подгрузить внутренний справочник для сопоставления.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {results.length > 0 && (
            <>
              {/* Карточки с компактной сводкой */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {results.map((r) => {
                  const isError = r.status === "error";
                  return (
                    <Card
                      key={r.input.id}
                      className="cursor-pointer hover-elevate"
                      onClick={() => !isError && setSelectedResult(r)}
                      data-testid={`card-result-${r.input.id}`}
                    >
                      <CardContent className="pt-4 pb-4 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            {r.input.code && (
                              <div className="text-xs text-muted-foreground font-mono">
                                {r.input.code}
                              </div>
                            )}
                            <div className="font-medium text-sm truncate" title={r.input.name}>
                              {r.input.name}
                            </div>
                          </div>
                          {isError ? (
                            <Badge variant="destructive" className="shrink-0">
                              <AlertCircle className="w-3 h-3 mr-1" />
                              Ошибка
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="shrink-0">
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              {r.analogs.length} аналогов
                            </Badge>
                          )}
                        </div>
                        {r.info && (
                          <>
                            <div className="text-xs text-muted-foreground line-clamp-2">
                              {r.info.description}
                            </div>
                            <div className="flex flex-wrap gap-1.5 pt-1">
                              {r.info.manufacturer && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  <Factory className="w-3 h-3 mr-1" />
                                  {r.info.manufacturer}
                                </Badge>
                              )}
                              {r.info.priceRange && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  {r.info.priceRange}
                                </Badge>
                              )}
                            </div>
                          </>
                        )}
                        {isError && (
                          <div className="text-xs text-destructive">{r.error}</div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Сводная таблица */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Сводная таблица аналогов</CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[220px]">Исходная позиция</TableHead>
                          <TableHead className="min-w-[220px]">Аналог</TableHead>
                          <TableHead>Соответствие</TableHead>
                          <TableHead>Производитель</TableHead>
                          <TableHead>Цена</TableHead>
                          <TableHead>Справочник</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tableRows.map(({ r, a }, idx) => (
                          <TableRow key={`${r.input.id}-${idx}`}>
                            <TableCell className="align-top">
                              <div className="text-sm font-medium truncate max-w-[220px]" title={r.input.name}>
                                {r.input.name}
                              </div>
                              {r.input.code && (
                                <div className="text-xs text-muted-foreground font-mono">{r.input.code}</div>
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              {a ? (
                                <div className="text-sm max-w-[240px]" title={a.name}>{a.name}</div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              {a && (
                                <Badge variant="outline" className={matchLevelLabel(a.matchLevel).cls}>
                                  {matchLevelLabel(a.matchLevel).label}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="align-top text-sm">
                              {a?.manufacturer || <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="align-top text-sm">
                              {a?.price || <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="align-top text-sm">
                              {a?.internalMatch ? (
                                <div className="max-w-[180px]">
                                  <div className="text-sm truncate" title={a.internalMatch.name}>
                                    {a.internalMatch.name}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {Math.round(a.internalMatch.similarity * 100)}% совпадение
                                    {a.internalMatch.code && ` · ${a.internalMatch.code}`}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </section>
      </main>

      {/* Детальная карточка */}
      <Dialog open={!!selectedResult} onOpenChange={(o) => !o && setSelectedResult(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          {selectedResult && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg">{selectedResult.info?.title || selectedResult.input.name}</DialogTitle>
                <DialogDescription className="text-sm">
                  {selectedResult.input.code && (
                    <span className="font-mono text-xs mr-2">{selectedResult.input.code}</span>
                  )}
                  <span>Исходная позиция: {selectedResult.input.name}</span>
                </DialogDescription>
              </DialogHeader>

              {selectedResult.info && (
                <div className="space-y-5">
                  <p className="text-sm">{selectedResult.info.description}</p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {selectedResult.info.manufacturer && (
                      <InfoRow label="Производитель" value={selectedResult.info.manufacturer} />
                    )}
                    {selectedResult.info.brand && (
                      <InfoRow label="Бренд" value={selectedResult.info.brand} />
                    )}
                    {selectedResult.info.priceRange && (
                      <InfoRow label="Цена" value={selectedResult.info.priceRange} />
                    )}
                  </div>

                  {selectedResult.info.specs.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold mb-2">Технические характеристики</h3>
                      <div className="border border-border rounded-md divide-y divide-border">
                        {selectedResult.info.specs.map((s, i) => (
                          <div key={i} className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
                            <span className="text-muted-foreground">{s.label}</span>
                            <span className="font-medium text-right">{s.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedResult.info.suppliers.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold mb-2">Поставщики</h3>
                      <div className="space-y-1.5">
                        {selectedResult.info.suppliers.map((s, i) => (
                          <div key={i} className="flex items-center justify-between text-sm border border-border rounded-md px-3 py-2">
                            <span>{s.name}</span>
                            <span className="text-muted-foreground text-xs">{s.price || ""}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 className="text-sm font-semibold mb-2">Аналоги ({selectedResult.analogs.length})</h3>
                    <div className="space-y-2">
                      {selectedResult.analogs.map((a, i) => {
                        const lvl = matchLevelLabel(a.matchLevel);
                        return (
                          <div key={i} className="border border-border rounded-md p-3 space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="font-medium text-sm">{a.name}</div>
                                {a.manufacturer && (
                                  <div className="text-xs text-muted-foreground">{a.manufacturer}</div>
                                )}
                              </div>
                              <Badge variant="outline" className={lvl.cls}>
                                {lvl.label}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">{a.reason}</p>
                            <div className="flex flex-wrap items-center gap-2">
                              {a.price && (
                                <Badge variant="outline" className="text-xs font-normal">
                                  {a.price}
                                </Badge>
                              )}
                              {a.supplierUrl && (
                                <a
                                  href={a.supplierUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center text-xs text-primary hover:underline"
                                >
                                  Поставщик
                                  <ExternalLink className="w-3 h-3 ml-1" />
                                </a>
                              )}
                              {a.internalMatch && (
                                <Badge variant="secondary" className="text-xs font-normal">
                                  В справочнике: {a.internalMatch.name}{" "}
                                  ({Math.round(a.internalMatch.similarity * 100)}%)
                                </Badge>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-md px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
