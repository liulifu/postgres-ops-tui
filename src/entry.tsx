#!/usr/bin/env node
import React, {useEffect, useMemo, useState} from 'react';
import {Box, render, Text, useApp, useInput} from 'ink';
import {GatewayClient, type ProbeInfo, type QueryResult, type Snapshot} from './gateway.js';

const amber = '#ffbf33';
const dimAmber = '#8a681f';
const phosphor = '#f7d774';

type Lang = 'zh' | 'en';

const copy = {
  zh: {
    title: 'POSTGRESQL 运维终端',
    waiting: '等待数据库',
    scanning: '扫描中',
    online: '在线',
    loading: '正在预热屏幕',
    run: '执行',
    done: '完成',
    sqlRunning: '正在执行 SQL',
    sqlDone: 'SQL 完成',
    output: '输出区',
    inputHint: '按 i 输入 SQL 或 psql 命令',
    sqlPrompt: 'SQL>',
    footer: '↑/↓ 滚动  ←/→ 横向滚动  i 输入SQL  r刷新  c检查点  z中英切换  q退出',
    sqlFooter: 'Enter 换行/执行完整语句  Ctrl+R 执行  Ctrl+U 清空  Esc 返回',
    welcome: 'PostgreSQL 故障排查控制台',
    welcomeHelp: '按顶部快捷键直接运行诊断 SQL；按 i 输入自定义 SQL。',
    databases: '数据库',
    metrics: {
      connections: '连接',
      active: '活动',
      waiting: '等待',
      locks: '锁',
      blocked: '阻塞',
      db_mb: '容量MB'
    },
    probes: {
      a: '活动会话',
      b: '阻塞关系',
      w: '等待事件',
      l: '未授予锁',
      x: '长事务',
      s: '数据库大小',
      t: '表健康',
      n: '索引使用',
      g: '日志设置'
    }
  },
  en: {
    title: 'POSTGRESQL OPS TERMINAL',
    waiting: 'waiting for server',
    scanning: 'scanning',
    online: 'online',
    loading: 'warming display',
    run: 'running',
    done: 'done',
    sqlRunning: 'executing SQL',
    sqlDone: 'SQL complete',
    output: 'output',
    inputHint: 'press i to enter SQL or a psql command',
    sqlPrompt: 'SQL>',
    footer: 'up/down scroll  left/right pan  i SQL  r refresh  c checkpoint  z language  q quit',
    sqlFooter: 'Enter newline/execute complete statement  Ctrl+R run  Ctrl+U clear  Esc return',
    welcome: 'PostgreSQL troubleshooting console',
    welcomeHelp: 'Use the top shortcut keys to run diagnostic SQL, or press i for ad-hoc SQL.',
    databases: 'Databases',
    metrics: {
      connections: 'conn',
      active: 'active',
      waiting: 'waiting',
      locks: 'locks',
      blocked: 'blocked',
      db_mb: 'db_mb'
    },
    probes: {
      a: 'active sessions',
      b: 'blocked/blocking',
      w: 'wait events',
      l: 'ungranted locks',
      x: 'long xacts',
      s: 'db sizes',
      t: 'table health',
      n: 'index usage',
      g: 'logging settings'
    }
  }
} as const;

function App() {
  const {exit} = useApp();
  const gateway = useMemo(() => new GatewayClient(), []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [probes, setProbes] = useState<ProbeInfo[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [sql, setSql] = useState('');
  const [sqlCursor, setSqlCursor] = useState(0);
  const [sqlMode, setSqlMode] = useState(false);
  const [lang, setLang] = useState<Lang>('zh');
  const [status, setStatus] = useState<string>(copy.zh.loading);
  const [scrollY, setScrollY] = useState(0);
  const [scrollX, setScrollX] = useState(0);

  const refresh = async () => {
    setStatus(copy[lang].scanning);
    try {
      setSnapshot(await gateway.snapshot());
      setStatus(copy[lang].online);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const runProbe = async (key: string) => {
    const probe = probes.find(item => item.key === key);
    if (!probe) return;
    setStatus(`${copy[lang].run} ${probeLabel(probe, lang)}`);
    try {
      setResult(await gateway.runProbe(key));
      setStatus(copy[lang].done);
      setScrollX(0);
      setScrollY(0);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const runSql = async (statement: string) => {
    const trimmed = statement.trim();
    if (!trimmed) return;
    setStatus(copy[lang].sqlRunning);
    setSql('');
    setSqlCursor(0);
    setSqlMode(false);
    try {
      setResult(await gateway.runSql(trimmed));
      setStatus(copy[lang].sqlDone);
    } catch (error) {
      setResult({title: 'SQL error', sql: trimmed, output: error instanceof Error ? error.message : String(error)});
      setStatus('SQL error');
    }
    setScrollX(0);
    setScrollY(0);
    await refresh();
  };

  useEffect(() => {
    void gateway.probeMenu().then(setProbes).catch(error => setStatus(String(error)));
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(timer);
      gateway.close();
    };
  }, [gateway]);

  useInput((input, key) => {
    if (sqlMode) {
      if (key.escape) {
        setSqlMode(false);
        return;
      }
      if (key.ctrl && input === 'u') {
        setSql('');
        setSqlCursor(0);
        return;
      }
      if (key.ctrl && input === 'r') {
        void runSql(sql);
        return;
      }
      if (key.return) {
        if (isCompleteStatement(sql)) {
          void runSql(sql);
        } else {
          insertSqlText('\n', sql, sqlCursor, setSql, setSqlCursor);
        }
        return;
      }
      if (isBackspace(input, key) || isDeleteKey(input, key)) {
        if (isBackspace(input, key)) {
          deleteSqlBackward(sql, sqlCursor, setSql, setSqlCursor);
        } else {
          deleteSqlForward(sql, sqlCursor, setSql, setSqlCursor);
        }
        return;
      }
      if (key.leftArrow) {
        setSqlCursor(value => Math.max(0, value - 1));
        return;
      }
      if (key.rightArrow) {
        setSqlCursor(value => Math.min(sql.length, value + 1));
        return;
      }
      if (key.upArrow) {
        setSqlCursor(value => moveSqlCursorVertical(sql, value, -1));
        return;
      }
      if (key.downArrow) {
        setSqlCursor(value => moveSqlCursorVertical(sql, value, 1));
        return;
      }
      if (input) {
        insertSqlText(normalizePaste(input), sql, sqlCursor, setSql, setSqlCursor);
      }
      return;
    }

    if (input === 'q' || key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (input === 'z') {
      setLang(current => current === 'zh' ? 'en' : 'zh');
      return;
    }
    if (input === 'r') {
      void refresh();
      return;
    }
    if (input === 'c') {
      void gateway.checkpoint().then(done => setStatus(done.message)).then(refresh).catch(error => setStatus(String(error)));
      return;
    }
    if (input === 'i') {
      setSqlMode(true);
      return;
    }
    if (key.upArrow) setScrollY(value => Math.max(0, value - 1));
    if (key.downArrow) setScrollY(value => value + 1);
    if ((key as any).pageUp) setScrollY(value => Math.max(0, value - 10));
    if ((key as any).pageDown) setScrollY(value => value + 10);
    if (key.leftArrow) setScrollX(value => Math.max(0, value - 8));
    if (key.rightArrow) setScrollX(value => value + 8);
    if (probes.some(probe => probe.key === input)) void runProbe(input);
  });

  const terminalWidth = process.stdout.columns || 140;
  const terminalHeight = process.stdout.rows || 36;
  const outputWidth = Math.max(60, terminalWidth - 4);
  const outputHeight = Math.max(10, terminalHeight - 8);
  const output = result?.output ?? welcome(snapshot, lang);
  const title = result ? `${localizedTitle(result, probes, lang)}  ${result.sql}` : copy[lang].output;

  return (
    <Box flexDirection="column">
      <TopBar snapshot={snapshot} status={status} probes={probes} lang={lang} />
      <Box height={1}><Text color={dimAmber}>{'-'.repeat(outputWidth)}</Text></Box>
      {sqlMode ? (
        <SqlEditorModal sql={sql} cursor={sqlCursor} width={outputWidth} height={outputHeight} lang={lang} />
      ) : (
        <OutputPanel title={title} output={output} width={outputWidth} height={outputHeight} scrollX={scrollX} scrollY={scrollY} />
      )}
      <Footer sqlMode={sqlMode} lang={lang} />
    </Box>
  );
}

function TopBar({snapshot, status, probes, lang}: {snapshot: Snapshot | null; status: string; probes: ProbeInfo[]; lang: Lang}) {
  const c = copy[lang];
  const title = snapshot ? `${c.title} // ${snapshot.container}` : c.title;
  const version = snapshot?.server_version.split(',')[0] ?? c.waiting;
  return (
    <Box flexDirection="column">
      <Text color={amber} bold>{spacedTitle(title)}</Text>
      <Text color={phosphor}>{version}</Text>
      <Text color={dimAmber}>{snapshot?.collected_at ?? '--'}  STATUS={status}</Text>
      <Text color={amber}>{metricsLine(snapshot, lang)}</Text>
      <Text color={amber}>{probes.map(probe => `[${probe.key}] ${probeLabel(probe, lang)}`).join('  ')}</Text>
    </Box>
  );
}

function OutputPanel({title, output, width, height, scrollX, scrollY}: {title: string; output: string; width: number; height: number; scrollX: number; scrollY: number}) {
  const innerWidth = Math.max(20, width - 4);
  const lines = output.replace(/\t/g, '    ').split('\n');
  const startY = Math.min(scrollY, Math.max(0, lines.length - height));
  const maxLine = Math.max(title.length, ...lines.map(line => line.length));
  const startX = Math.min(scrollX, Math.max(0, maxLine - innerWidth));
  const visible = lines.slice(startY, startY + height);
  const vertical = `${startY + 1}-${Math.min(lines.length, startY + height)}/${Math.max(1, lines.length)}`;
  const horizontal = `${startX + 1}-${Math.min(maxLine, startX + innerWidth)}/${Math.max(1, maxLine)}`;

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={dimAmber} paddingX={1}>
      <Text color={amber} bold>{sliceMono(title, startX, innerWidth)}</Text>
      {visible.map((line, index) => <Text key={index} color={phosphor}>{sliceMono(line, startX, innerWidth)}</Text>)}
      {Array.from({length: Math.max(0, height - visible.length)}).map((_, index) => <Text key={`blank-${index}`}> </Text>)}
      <Text color={dimAmber}>{`Y ${vertical}  X ${horizontal}`}</Text>
    </Box>
  );
}

function SqlEditorModal({sql, cursor, width, height, lang}: {sql: string; cursor: number; width: number; height: number; lang: Lang}) {
  const modalWidth = Math.min(width, 110);
  const modalHeight = Math.min(height, 18);
  const marginLeft = Math.max(0, Math.floor((width - modalWidth) / 2));
  const marginTop = Math.max(0, Math.floor((height - modalHeight) / 2));
  const editorWidth = Math.max(24, modalWidth - 10);
  const editorHeight = Math.max(6, modalHeight - 6);
  const lines = splitSqlLines(sql);
  const cursorPosition = sqlCursorPosition(sql, cursor);
  const maxLineWidth = Math.max(1, ...lines.map(line => line.length), cursorPosition.column + 1);
  const startY = clamp(cursorPosition.line - editorHeight + 1, 0, Math.max(0, lines.length - editorHeight));
  const startX = clamp(cursorPosition.column - editorWidth + 1, 0, Math.max(0, maxLineWidth - editorWidth));
  const visible = lines.slice(startY, startY + editorHeight);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {Array.from({length: marginTop}).map((_, index) => <Text key={`top-${index}`}> </Text>)}
      <Box marginLeft={marginLeft} flexDirection="column" width={modalWidth} borderStyle="double" borderColor={amber} paddingX={1}>
        <Text color={amber} bold>{copy[lang].sqlPrompt} EDITOR</Text>
        <Text color={dimAmber}>{copy[lang].sqlFooter}</Text>
        <Text color={dimAmber}>{scrollBar(lines.length, startY, editorHeight, 18)}  {scrollBar(maxLineWidth, startX, editorWidth, 18)}</Text>
        {visible.map((line, index) => {
          const lineNumber = startY + index;
          return (
            <Text key={lineNumber}>
              <Text color={dimAmber}>{String(lineNumber + 1).padStart(4)} | </Text>
              <SqlLine line={line} startX={startX} width={editorWidth} cursorColumn={lineNumber === cursorPosition.line ? cursorPosition.column : null} />
            </Text>
          );
        })}
        {Array.from({length: Math.max(0, editorHeight - visible.length)}).map((_, index) => <Text key={`blank-${index}`}> </Text>)}
        <Text color={dimAmber}>{isCompleteStatement(sql) ? 'ready: Enter executes' : 'draft: Enter inserts newline, Ctrl+R executes'}</Text>
      </Box>
    </Box>
  );
}

function SqlLine({line, startX, width, cursorColumn}: {line: string; startX: number; width: number; cursorColumn: number | null}) {
  const visible = sliceMono(line, startX, width);
  if (cursorColumn === null || cursorColumn < startX || cursorColumn > startX + width) {
    return <HighlightedSql text={visible} />;
  }
  const local = cursorColumn - startX;
  const before = visible.slice(0, local);
  const char = visible[local] === ' ' ? ' ' : visible[local];
  const after = visible.slice(local + 1);
  return (
    <>
      <HighlightedSql text={before} />
      <Text color="#1b1605" backgroundColor={amber}>{char || ' '}</Text>
      <HighlightedSql text={after} />
    </>
  );
}

function HighlightedSql({text}: {text: string}) {
  const pattern = /(--.*$|'(?:''|[^'])*'|\b(?:select|from|where|join|left|right|inner|outer|on|create|view|table|index|insert|update|delete|drop|alter|as|and|or|not|null|is|group|order|by|limit|having|with|union|values|into)\b|\b\d+(?:\.\d+)?\b)/gi;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push(<Text key={`plain-${cursor}`} color={phosphor}>{text.slice(cursor, index)}</Text>);
    }
    const value = match[0];
    parts.push(<Text key={`match-${index}`} color={sqlTokenColor(value)} bold={isSqlKeyword(value)}>{value}</Text>);
    cursor = index + value.length;
  }
  if (cursor < text.length) {
    parts.push(<Text key={`plain-${cursor}`} color={phosphor}>{text.slice(cursor)}</Text>);
  }
  return <>{parts}</>;
}

function Footer({sqlMode, lang}: {sqlMode: boolean; lang: Lang}) {
  return (
    <Box height={1}>
      <Text color={dimAmber}>{sqlMode ? copy[lang].sqlFooter : copy[lang].footer}</Text>
    </Box>
  );
}

function metricsLine(snapshot: Snapshot | null, lang: Lang): string {
  if (!snapshot) return '';
  const labels = copy[lang].metrics;
  return snapshot.metrics
    .map(metric => `${labels[metric.label as keyof typeof labels] ?? metric.label}:${metric.value}`)
    .join('  ');
}

function probeLabel(probe: ProbeInfo, lang: Lang): string {
  return copy[lang].probes[probe.key as keyof typeof copy.zh.probes] ?? probe.title;
}

function localizedTitle(result: QueryResult, probes: ProbeInfo[], lang: Lang): string {
  const found = probes.find(probe => probe.title === result.title);
  return found ? probeLabel(found, lang) : result.title;
}

function welcome(snapshot: Snapshot | null, lang: Lang): string {
  const c = copy[lang];
  if (!snapshot) return c.waiting;
  const dbs = snapshot.databases
    .map(db => `${db.name.padEnd(16)} conns=${db.connections} commits=${db.commits} rollbacks=${db.rollbacks} size=${db.size}`)
    .join('\n');
  return [
    c.welcome,
    '',
    c.welcomeHelp,
    '',
    c.databases,
    dbs || '(none)'
  ].join('\n');
}

function isCompleteStatement(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('\\') || trimmed.endsWith(';');
}

function insertSqlText(text: string, sql: string, cursor: number, setSql: (value: string) => void, setCursor: (value: number) => void): void {
  const next = sql.slice(0, cursor) + text + sql.slice(cursor);
  setSql(next);
  setCursor(cursor + text.length);
}

function deleteSqlBackward(sql: string, cursor: number, setSql: (value: string) => void, setCursor: (value: number) => void): void {
  if (cursor === 0) return;
  setSql(sql.slice(0, cursor - 1) + sql.slice(cursor));
  setCursor(cursor - 1);
}

function deleteSqlForward(sql: string, cursor: number, setSql: (value: string) => void, setCursor: (value: number) => void): void {
  if (cursor >= sql.length) return;
  setSql(sql.slice(0, cursor) + sql.slice(cursor + 1));
  setCursor(cursor);
}

function isBackspace(input: string, key: any): boolean {
  return Boolean(key.backspace || key.backspaceKey || input === '\b' || input === '\x7f' || key.ctrl && input === 'h');
}

function isDeleteKey(input: string, key: any): boolean {
  return Boolean(key.delete || key.deleteKey || key.name === 'delete' || input === '\x1b[3~');
}

function moveSqlCursorVertical(sql: string, cursor: number, delta: number): number {
  const lines = splitSqlLines(sql);
  const current = sqlCursorPosition(sql, cursor);
  const targetLine = clamp(current.line + delta, 0, lines.length - 1);
  const targetColumn = Math.min(current.column, lines[targetLine]?.length ?? 0);
  return sqlIndexFromPosition(lines, targetLine, targetColumn);
}

function splitSqlLines(sql: string): string[] {
  return sql.split('\n');
}

function sqlCursorPosition(sql: string, cursor: number): {line: number; column: number} {
  const prefix = sql.slice(0, cursor);
  const lines = prefix.split('\n');
  return {line: lines.length - 1, column: lines[lines.length - 1]?.length ?? 0};
}

function sqlIndexFromPosition(lines: string[], line: number, column: number): number {
  let index = 0;
  for (let current = 0; current < line; current++) {
    index += (lines[current]?.length ?? 0) + 1;
  }
  return index + column;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scrollBar(total: number, start: number, size: number, width: number): string {
  if (total <= size) return `[${'█'.repeat(width)}]`;
  const thumb = Math.max(1, Math.round((size / total) * width));
  const offset = Math.round((start / Math.max(1, total - size)) * (width - thumb));
  return `[${' '.repeat(offset)}${'█'.repeat(thumb)}${' '.repeat(width - thumb - offset)}]`;
}

function sqlTokenColor(value: string): string {
  if (value.startsWith('--')) return dimAmber;
  if (value.startsWith("'")) return '#ffe08a';
  if (/^\d/.test(value)) return '#f59e0b';
  return amber;
}

function isSqlKeyword(value: string): boolean {
  return /^[a-z]+$/i.test(value);
}

function normalizePaste(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sliceMono(value: string, start: number, width: number): string {
  const sliced = value.slice(start, start + width);
  return sliced.length >= width ? sliced : sliced.padEnd(width, ' ');
}

function spacedTitle(value: string): string {
  return value.toUpperCase().split('').join(' ');
}

render(<App />);
