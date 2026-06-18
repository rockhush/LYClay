import { useMemo, useState } from 'react';
import { Package, Search, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { AI_TOOLS, type AiToolItem } from './data';

const TOOL_COLOR = 'bg-[#FF922B]';
const MAX_TAG_COUNT = 3;
const MAX_TAG_CHARS = 5;

function formatTagLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= MAX_TAG_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TAG_CHARS)}...`;
}

function parseTags(tag: string): string[] {
  return tag
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getToolInitial(name: string): string {
  if (!name) return '工';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : '工';
}

function ToolTagRow({ tags }: { tags: string[] }) {
  const visibleTags = tags.slice(0, MAX_TAG_COUNT);

  return (
    <div className="mt-2 flex h-[26px] min-h-[26px] items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {visibleTags.map((tag) => {
        const displayLabel = formatTagLabel(tag);
        return (
          <Tooltip key={tag}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex max-w-[5.5rem] shrink-0 items-center rounded-full bg-[#FFF2E5] px-2.5 py-1 text-[11px] font-normal leading-none text-[#FF922B] dark:bg-[#FF922B]/15"
              >
                {displayLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[12px]">
              {tag}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ToolDescriptionRow({ description }: { description: string }) {
  const displayText = description.trim() || '—';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <p className="mt-3 h-[3.1em] min-h-[3.1em] text-[12.5px] text-muted-foreground leading-[1.55] line-clamp-2 break-words">
          {displayText}
        </p>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs whitespace-normal break-words">
        {displayText}
      </TooltipContent>
    </Tooltip>
  );
}

function matchesSearch(tool: AiToolItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  const haystack = [
    tool.name,
    tool.desc,
    tool.tag,
    tool.type,
    tool.url,
  ].join(' ').toLowerCase();

  return haystack.includes(normalized);
}

function AiToolCard({ tool }: { tool: AiToolItem }) {
  const initial = getToolInitial(tool.name);
  const tags = parseTags(tool.tag);

  const handleOpen = () => {
    void invokeIpc('shell:openExternal', tool.url);
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      data-testid={`ai-tool-card-${tool.name}`}
      className={cn(
        'group relative flex h-full w-full flex-col text-left rounded-2xl border transition-colors p-4 overflow-hidden cursor-pointer',
        'border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04]',
        'hover:bg-[#FFF2E5]/70 hover:border-[#FF922B]/25 dark:hover:bg-white/[0.06]',
      )}
    >
      <div className="flex items-center gap-3 w-full">
        <div
          className={cn(
            'w-7 h-7 shrink-0 flex items-center justify-center text-[12px] font-semibold text-white rounded-lg overflow-hidden',
            TOOL_COLOR,
          )}
        >
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[14px] font-normal text-foreground truncate">{tool.name}</h3>
            <span className="text-[11px] leading-none text-muted-foreground/70 truncate">
              {tool.type.trim() || '—'}
            </span>
          </div>
        </div>
      </div>

      <ToolTagRow tags={tags} />

      <ToolDescriptionRow description={tool.desc} />
    </button>
  );
}

export function AiTools() {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTools = useMemo(
    () => AI_TOOLS.filter((tool) => matchesSearch(tool, searchQuery)),
    [searchQuery],
  );

  return (
    <div className="relative flex flex-col -m-6 h-[calc(100vh-2.5rem)] overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 dark:hidden"
        style={{
          background:
            'radial-gradient(120% 80% at 80% 20%, hsl(28 60% 95% / 0.85) 0%, hsl(28 50% 96% / 0.6) 35%, hsl(0 0% 100% / 0) 70%), radial-gradient(80% 60% at 20% 90%, hsl(18 80% 92% / 0.55) 0%, hsl(0 0% 100% / 0) 60%)',
        }}
      />

      <div className="relative z-10 flex flex-col h-full w-full max-w-[1400px] mx-auto px-8 pt-[2em] pb-6">
        <div className="flex flex-row items-center justify-between mb-5 shrink-0 gap-4">
          <div>
            <h1 className="text-[20px] font-bold text-foreground leading-tight">AI工具</h1>
            <p className="text-[13px] text-muted-foreground mt-1">浏览并打开可用的 AI 工具</p>
          </div>

          <div className="relative flex items-center bg-[#FFF2E5] dark:bg-[#FF922B]/15 rounded-full px-3 py-1.5 border border-transparent focus-within:border-[#FF922B]/40 transition-colors w-64 shrink-0">
            <Search className="h-3.5 w-3.5 text-[#FF922B] shrink-0" />
            <input
              placeholder="搜索 AI 工具"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              data-testid="ai-tools-search"
              className="ml-2 bg-transparent outline-none w-full text-[13px] text-foreground placeholder:text-[#FF922B]/80"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-[#FF922B]/70 hover:text-[#FF922B] shrink-0 ml-1"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {filteredTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Package className="h-10 w-10 mb-4 opacity-50" />
              <p>{searchQuery.trim() ? '未找到匹配的 AI 工具' : '暂无 AI 工具'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-stretch">
              {filteredTools.map((tool) => (
                <AiToolCard key={`${tool.name}-${tool.url}`} tool={tool} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
