#!/usr/bin/env node
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Box, render, Text, useApp, useInput, useStdin} from 'ink';
import {GatewayClient, type ChoiceInfo, type ProbeInfo, type QueryResult, type Snapshot} from './gateway.js';

const amber = '#ffbf33';
const dimAmber = '#8a681f';
const phosphor = '#f7d774';
const cyan = '#35d6ff';
const magenta = '#ff4fd8';
const green = '#9cff6e';
const red = '#ff5a5f';
const blue = '#5b7cff';

type Lang = 'zh' | 'en';
type MenuGroupKey = '1' | '2' | '3' | '4';
type FormTab = 'vars' | 'preview';
type FormFieldKind = 'text' | 'password' | 'boolean' | 'csv';
type LookupKind = 'roles' | 'login_roles';

type FormOption = {
  label: string;
  value: string;
};

type FormField = {
  name: string;
  label: string;
  placeholder?: string;
  kind?: FormFieldKind;
  defaultValue?: string;
  options?: FormOption[];
  lookup?: LookupKind;
};

type MenuItem = {
  key: string;
  label: string;
  description: string;
  action?: 'resource_health';
  sql?: string;
  probeKey?: string;
  fields?: FormField[];
  buildSql?: (values: Record<string, string>) => string;
};

type MenuGroup = {
  key: MenuGroupKey;
  title: string;
  items: MenuItem[];
};

type FormState = {
  item: MenuItem;
  values: Record<string, string>;
  cursor: number;
  fieldIndex: number;
  tab: FormTab;
};

type PickerState = {
  mode: 'field' | 'connection' | 'script';
  fieldIndex?: number;
  title: string;
  options: ChoiceInfo[];
  selectedIndex: number;
  loading: boolean;
  error?: string;
};

type ParsedTable = {
  headers: string[];
  rows: string[][];
  notes: string[];
};

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
    footer: '1用户  2授权  3资源/性能  4排障  i SQL  r刷新  z中英  q退出',
    sqlFooter: 'Enter 换行/执行完整语句  Backspace/Delete 删除  Ctrl+R 执行  Ctrl+U 清空  Esc 返回',
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
    footer: '1 users  2 grants  3 resource/perf  4 troubleshooting  i SQL  r refresh  z lang  q quit',
    sqlFooter: 'Enter newline/execute complete statement  Backspace/Delete remove  Ctrl+R run  Ctrl+U clear  Esc return',
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

const logoLines = [
  '   ____   ____        ___  ____  ____',
  '  |  _ \\ / ___|      / _ \\|  _ \\/ ___|',
  '  | |_) | |  _ _____| | | | |_) \\___ \\',
  '  |  __/| |_| |_____| |_| |  __/ ___) |',
  '  |_|    \\____|      \\___/|_|   |____/'
];

function menuGroups(lang: Lang): MenuGroup[] {
  const zh = lang === 'zh';
  return [
    {
      key: '1',
      title: zh ? '用户管理' : 'Users',
      items: [
        {
          key: 'L',
          label: zh ? '所有用户列表' : 'List roles',
          description: zh ? '查看登录能力、建库/建角色权限和过期时间' : 'Show login, create-db, create-role and expiry flags',
          sql: `select rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolvaliduntil
from pg_roles
order by rolname;`
        },
        {
          key: 'A',
          label: zh ? '添加用户' : 'Create user',
          description: zh ? '填写变量并预览 CREATE ROLE SQL' : 'Fill variables and preview CREATE ROLE SQL',
          fields: [
            {name: 'role_name', label: zh ? '用户名' : 'Role name', placeholder: 'app_user'},
            {name: 'password', label: zh ? '密码' : 'Password', kind: 'password', placeholder: 'strong-password'},
            {name: 'can_login', label: zh ? '允许登录' : 'Can login', kind: 'boolean', defaultValue: 'true'},
            {name: 'create_db', label: zh ? '允许建库' : 'Create DB', kind: 'boolean', defaultValue: 'false'},
            {name: 'create_role', label: zh ? '允许建角色' : 'Create role', kind: 'boolean', defaultValue: 'false'},
            {name: 'superuser', label: zh ? '超级用户' : 'Superuser', kind: 'boolean', defaultValue: 'false'},
            {name: 'valid_until', label: zh ? '过期时间' : 'Valid until', placeholder: '2026-12-31 23:59:59'}
          ],
          buildSql: values => {
            const options = [
              boolSql(values.can_login, 'LOGIN', 'NOLOGIN'),
              boolSql(values.create_db, 'CREATEDB', 'NOCREATEDB'),
              boolSql(values.create_role, 'CREATEROLE', 'NOCREATEROLE'),
              boolSql(values.superuser, 'SUPERUSER', 'NOSUPERUSER'),
              values.password ? `PASSWORD ${sqlString(values.password)}` : '',
              values.valid_until ? `VALID UNTIL ${sqlString(values.valid_until)}` : ''
            ].filter(Boolean);
            return `create role ${sqlIdent(values.role_name || 'new_role')} ${options.join(' ')};`;
          }
        },
        {
          key: 'D',
          label: zh ? '删除用户' : 'Drop user',
          description: zh ? '生成 DROP ROLE IF EXISTS' : 'Generate DROP ROLE IF EXISTS',
          fields: [{name: 'role_name', label: zh ? '用户名' : 'Role name', placeholder: 'old_user', lookup: 'login_roles'}],
          buildSql: values => `drop role if exists ${sqlIdent(values.role_name || 'old_role')};`
        },
        {
          key: 'P',
          label: zh ? '修改密码' : 'Reset password',
          description: zh ? '为现有角色设置新密码' : 'Set a new password for an existing role',
          fields: [
            {name: 'role_name', label: zh ? '用户名' : 'Role name', placeholder: 'app_user', lookup: 'login_roles'},
            {name: 'password', label: zh ? '新密码' : 'New password', kind: 'password'}
          ],
          buildSql: values => `alter role ${sqlIdent(values.role_name || 'app_user')} with password ${sqlString(values.password || '')};`
        }
      ]
    },
    {
      key: '2',
      title: zh ? '授权管理' : 'Grants',
      items: [
        {
          key: 'L',
          label: zh ? '用户授权总览' : 'User grant overview',
          description: zh ? '查看角色成员关系和表权限' : 'Show role memberships and table grants',
          sql: `select member.rolname as user_name, role.rolname as granted_role, grantor.rolname as grantor, auth.admin_option
from pg_auth_members auth
join pg_roles role on role.oid = auth.roleid
join pg_roles member on member.oid = auth.member
join pg_roles grantor on grantor.oid = auth.grantor
order by member.rolname, role.rolname;

select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name, grantee, privilege_type;`
        },
        {
          key: 'M',
          label: zh ? '授予角色给用户' : 'Grant role to user',
          description: zh ? 'GRANT role TO user，用角色当权限组' : 'Grant a role membership to a user',
          fields: [
            {name: 'role_name', label: zh ? '权限角色' : 'Granted role', placeholder: 'app_readonly', lookup: 'roles'},
            {name: 'target_user', label: zh ? '目标用户' : 'Target user', placeholder: 'app_user', lookup: 'login_roles'},
            {name: 'admin_option', label: zh ? '可再授权' : 'Admin option', kind: 'boolean', defaultValue: 'false'}
          ],
          buildSql: values => `grant ${sqlIdent(values.role_name || 'app_role')} to ${sqlIdent(values.target_user || 'app_user')}${isTrue(values.admin_option) ? ' with admin option' : ''};`
        },
        {
          key: 'U',
          label: zh ? '回收角色授权' : 'Revoke role from user',
          description: zh ? 'REVOKE role FROM user' : 'Revoke role membership from a user',
          fields: [
            {name: 'role_name', label: zh ? '权限角色' : 'Granted role', placeholder: 'app_readonly', lookup: 'roles'},
            {name: 'target_user', label: zh ? '目标用户' : 'Target user', placeholder: 'app_user', lookup: 'login_roles'}
          ],
          buildSql: values => `revoke ${sqlIdent(values.role_name || 'app_role')} from ${sqlIdent(values.target_user || 'app_user')};`
        },
        {
          key: 'D',
          label: zh ? '授予数据库权限' : 'Grant database',
          description: zh ? 'GRANT CONNECT/CREATE/TEMP ON DATABASE' : 'Grant CONNECT/CREATE/TEMP on a database',
          fields: [
            {name: 'target_user', label: zh ? '目标用户' : 'Target user', placeholder: 'app_user', lookup: 'login_roles'},
            {name: 'database_name', label: zh ? '数据库' : 'Database', placeholder: 'postgres'},
            {name: 'privileges', label: zh ? '权限' : 'Privileges', defaultValue: 'CONNECT', options: [
              {label: 'CONNECT', value: 'CONNECT'},
              {label: 'CREATE', value: 'CREATE'},
              {label: 'TEMP', value: 'TEMPORARY'},
              {label: 'CONNECT+TEMP', value: 'CONNECT, TEMPORARY'},
              {label: 'ALL', value: 'ALL PRIVILEGES'}
            ]}
          ],
          buildSql: values => `grant ${values.privileges || 'CONNECT'} on database ${sqlIdent(values.database_name || 'postgres')} to ${sqlIdent(values.target_user || 'app_user')};`
        },
        {
          key: 'S',
          label: zh ? '授予 Schema 权限' : 'Grant schema',
          description: zh ? 'GRANT USAGE/CREATE ON SCHEMA' : 'Grant USAGE/CREATE on a schema',
          fields: [
            {name: 'target_user', label: zh ? '目标用户' : 'Target user', placeholder: 'app_user', lookup: 'login_roles'},
            {name: 'schema_name', label: zh ? 'Schema' : 'Schema', defaultValue: 'public'},
            {name: 'privileges', label: zh ? '权限' : 'Privileges', defaultValue: 'USAGE', options: [
              {label: 'USAGE', value: 'USAGE'},
              {label: 'CREATE', value: 'CREATE'},
              {label: 'USAGE+CREATE', value: 'USAGE, CREATE'}
            ]}
          ],
          buildSql: values => `grant ${values.privileges || 'USAGE'} on schema ${sqlIdent(values.schema_name || 'public')} to ${sqlIdent(values.target_user || 'app_user')};`
        },
        {
          key: 'T',
          label: zh ? '授予单表权限' : 'Grant table',
          description: zh ? 'GRANT SELECT/DML/ALL ON TABLE TO user' : 'Grant SELECT/DML/ALL on one table',
          fields: [
            {name: 'target_user', label: zh ? '目标用户' : 'Target user', placeholder: 'app_user', lookup: 'login_roles'},
            {name: 'schema_name', label: zh ? 'Schema' : 'Schema', defaultValue: 'public'},
            {name: 'table_name', label: zh ? '表名' : 'Table', placeholder: 'orders'},
            {name: 'privileges', label: zh ? '权限预设' : 'Privilege set', defaultValue: 'SELECT', options: tablePrivilegeOptions()}
          ],
          buildSql: values => `grant ${sqlPrivilegePreset(values.privileges || 'SELECT')} on table ${sqlIdent(values.schema_name || 'public')}.${sqlIdent(values.table_name || 'table_name')} to ${sqlIdent(values.target_user || 'app_user')};`
        },
        {
          key: 'A',
          label: zh ? '授予全部表' : 'Grant all tables',
          description: zh ? '对 schema 下所有已有表授权' : 'Grant on all existing tables in a schema',
          fields: [
            {name: 'target_user', label: zh ? '目标用户' : 'Target user', placeholder: 'app_user', lookup: 'login_roles'},
            {name: 'schema_name', label: zh ? 'Schema' : 'Schema', defaultValue: 'public'},
            {name: 'privileges', label: zh ? '权限预设' : 'Privilege set', defaultValue: 'SELECT', options: tablePrivilegeOptions()}
          ],
          buildSql: values => `grant ${sqlPrivilegePreset(values.privileges || 'SELECT')} on all tables in schema ${sqlIdent(values.schema_name || 'public')} to ${sqlIdent(values.target_user || 'app_user')};`
        },
        {
          key: 'F',
          label: zh ? '默认表权限' : 'Default table grants',
          description: zh ? '让未来新建表自动授权给用户' : 'Grant future tables created in a schema',
          fields: [
            {name: 'target_user', label: zh ? '目标用户' : 'Target user', placeholder: 'app_user', lookup: 'login_roles'},
            {name: 'schema_name', label: zh ? 'Schema' : 'Schema', defaultValue: 'public'},
            {name: 'privileges', label: zh ? '权限预设' : 'Privilege set', defaultValue: 'SELECT', options: tablePrivilegeOptions()}
          ],
          buildSql: values => `alter default privileges in schema ${sqlIdent(values.schema_name || 'public')} grant ${sqlPrivilegePreset(values.privileges || 'SELECT')} on tables to ${sqlIdent(values.target_user || 'app_user')};`
        }
      ]
    },
    {
      key: '3',
      title: zh ? '资源/性能' : 'Resource/Perf',
      items: [
        {key: 'H', label: zh ? '资源体检' : 'Health report', description: zh ? '按阈值评价 CPU/内存/磁盘/连接/缓存/Vacuum' : 'Score CPU/memory/disk/connections/cache/vacuum', action: 'resource_health'},
        {key: 'D', label: zh ? '数据库容量' : 'DB sizes', description: zh ? '查看数据库大小' : 'Show database sizes', probeKey: 's'},
        {key: 'A', label: zh ? '活动会话' : 'Active sessions', description: zh ? '查看当前活动 SQL' : 'Inspect active SQL', probeKey: 'a'},
        {key: 'I', label: zh ? '索引使用' : 'Index usage', description: zh ? '查看索引扫描情况' : 'Show index scan usage', probeKey: 'n'},
        {key: 'T', label: zh ? '表健康' : 'Table health', description: zh ? '查看 dead tuple / vacuum 信号' : 'Show dead tuple and vacuum signals', probeKey: 't'},
        {key: 'W', label: zh ? '等待事件' : 'Wait events', description: zh ? '聚合等待事件' : 'Aggregate wait events', probeKey: 'w'}
      ]
    },
    {
      key: '4',
      title: zh ? '日常排障' : 'Troubleshooting',
      items: [
        {key: 'B', label: zh ? '阻塞链路' : 'Blocking graph', description: zh ? '查看 blocked/blocking 关系' : 'Show blocked/blocking relations', probeKey: 'b'},
        {key: 'L', label: zh ? '未授予锁' : 'Ungranted locks', description: zh ? '定位等待锁' : 'Locate waiting locks', probeKey: 'l'},
        {key: 'X', label: zh ? '长事务' : 'Long xacts', description: zh ? '查看长事务和 idle in transaction' : 'Show long transactions', probeKey: 'x'},
        {key: 'K', label: zh ? '终止后端 PID' : 'Terminate PID', description: zh ? '生成 pg_terminate_backend SQL' : 'Generate pg_terminate_backend SQL', fields: [{name: 'pid', label: 'PID', placeholder: '12345'}], buildSql: values => `select pg_terminate_backend(${sqlInteger(values.pid || '0')});`},
        {key: 'C', label: zh ? '检查点' : 'Checkpoint', description: zh ? '请求 PostgreSQL checkpoint' : 'Request PostgreSQL checkpoint', sql: 'checkpoint;'}
      ]
    }
  ];
}
function App() {
  const {exit} = useApp();
  const {stdin} = useStdin();
  const gateway = useMemo(() => new GatewayClient(), []);
  const rawInputRef = useRef('');
  const horizontalNavRef = useRef({direction: 0, at: 0, streak: 0});
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [probes, setProbes] = useState<ProbeInfo[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [sql, setSql] = useState('');
  const [sqlCursor, setSqlCursor] = useState(0);
  const [sqlMode, setSqlMode] = useState(false);
  const [lang, setLang] = useState<Lang>('en');
  const groups = useMemo(() => menuGroups(lang), [lang]);
  const [status, setStatus] = useState<string>(copy.zh.loading);
  const [scrollY, setScrollY] = useState(0);
  const [scrollX, setScrollX] = useState(0);
  const [openMenu, setOpenMenu] = useState<MenuGroupKey | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [busyTick, setBusyTick] = useState(0);

  const activeGroup = openMenu ? groups.find(group => group.key === openMenu) ?? null : null;
  const moveHorizontal = (direction: -1 | 1) => {
    const now = Date.now();
    const previous = horizontalNavRef.current;
    const streak = previous.direction === direction && now - previous.at < 260 ? previous.streak + 1 : 0;
    horizontalNavRef.current = {direction, at: now, streak};
    const step = Math.min(96, 14 + streak * 6);
    setScrollX(value => direction > 0 ? value + step : Math.max(0, value - step));
  };

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
    setBusyLabel(`reading ${probeLabel(probe, lang)}`);
    try {
      setResult(await gateway.runProbe(key));
      setStatus(copy[lang].done);
      setScrollX(0);
      setScrollY(0);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel(null);
    }
    await refresh();
  };

  const runSql = async (statement: string) => {
    const trimmed = statement.trim();
    if (!trimmed) return;
    setStatus(copy[lang].sqlRunning);
    setSql('');
    setSqlCursor(0);
    setSqlMode(false);
    setBusyLabel('executing SQL');
    try {
      setResult(await gateway.runSql(trimmed));
      setStatus(copy[lang].sqlDone);
    } catch (error) {
      setResult({title: 'SQL error', sql: trimmed, output: error instanceof Error ? error.message : String(error)});
      setStatus('SQL error');
    } finally {
      setBusyLabel(null);
    }
    setScrollX(0);
    setScrollY(0);
    await refresh();
  };

  const openForm = (item: MenuItem) => {
    const values = Object.fromEntries((item.fields ?? []).map(field => [field.name, field.defaultValue ?? '']));
    setFormState({item, values, cursor: values[(item.fields ?? [])[0]?.name ?? '']?.length ?? 0, fieldIndex: 0, tab: 'vars'});
    setOpenMenu(null);
  };

  const runMenuItem = async (item: MenuItem) => {
    if (item.fields && item.buildSql) {
      openForm(item);
      return;
    }
    setOpenMenu(null);
    if (item.action === 'resource_health') {
      setStatus(copy[lang].scanning);
      setBusyLabel(lang === 'zh' ? '读取资源体检数据' : 'reading resource health');
      try {
        setResult(await gateway.resourceHealth());
        setStatus(copy[lang].done);
        setScrollX(0);
        setScrollY(0);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyLabel(null);
      }
      return;
    }
    if (item.probeKey) {
      await runProbe(item.probeKey);
      return;
    }
    if (item.sql) {
      await runSql(item.sql);
    }
  };

  const submitForm = () => {
    if (!formState || !formState.item.buildSql) return;
    void runSql(formState.item.buildSql(formState.values));
    setFormState(null);
  };

  const openFieldPicker = async () => {
    if (!formState) return;
    const field = formState.item.fields?.[formState.fieldIndex];
    if (!field?.lookup) return;
    setPickerState({mode: 'field', fieldIndex: formState.fieldIndex, title: field.label, options: [], selectedIndex: 0, loading: true});
    try {
      const options = await gateway.roleChoices(field.lookup);
      const currentValue = formState.values[field.name] ?? '';
      const selectedIndex = Math.max(0, options.findIndex(option => option.value === currentValue));
      setPickerState({mode: 'field', fieldIndex: formState.fieldIndex, title: field.label, options, selectedIndex, loading: false});
    } catch (error) {
      setPickerState({
        mode: 'field',
        fieldIndex: formState.fieldIndex,
        title: field.label,
        options: [],
        selectedIndex: 0,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const openConnectionPicker = async () => {
    setPickerState({mode: 'connection', title: lang === 'zh' ? 'PG 连接' : 'PG connection', options: [], selectedIndex: 0, loading: true});
    try {
      const options = await gateway.connectionProfiles();
      const selectedIndex = Math.max(0, options.findIndex(option => option.active));
      setPickerState({mode: 'connection', title: lang === 'zh' ? 'PG 连接' : 'PG connection', options, selectedIndex, loading: false});
    } catch (error) {
      setPickerState({mode: 'connection', title: 'PG connection', options: [], selectedIndex: 0, loading: false, error: error instanceof Error ? error.message : String(error)});
    }
  };

  const openScriptPicker = async () => {
    setPickerState({mode: 'script', title: lang === 'zh' ? '自定义 SQL 脚本' : 'SQL script', options: [], selectedIndex: 0, loading: true});
    try {
      const options = await gateway.scriptChoices();
      setPickerState({mode: 'script', title: lang === 'zh' ? '自定义 SQL 脚本' : 'SQL script', options, selectedIndex: 0, loading: false});
    } catch (error) {
      setPickerState({mode: 'script', title: 'SQL script', options: [], selectedIndex: 0, loading: false, error: error instanceof Error ? error.message : String(error)});
    }
  };

  const confirmPicker = async () => {
    if (!pickerState) return;
    const selected = pickerState.options[pickerState.selectedIndex];
    if (!selected) {
      setPickerState(null);
      return;
    }
    if (pickerState.mode === 'connection') {
      setPickerState(null);
      setBusyLabel(`connecting ${selected.label}`);
      try {
        const connection = await gateway.setConnection(selected.value);
        setStatus(`connected ${connection.label}`);
        setResult(null);
        setScrollX(0);
        setScrollY(0);
        await refresh();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyLabel(null);
      }
      return;
    }
    if (pickerState.mode === 'script') {
      setPickerState(null);
      setBusyLabel(`running ${selected.label}`);
      try {
        setResult(await gateway.runScript(selected.value));
        setStatus(copy[lang].done);
        setScrollX(0);
        setScrollY(0);
        await refresh();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyLabel(null);
      }
      return;
    }
    if (!formState || pickerState.fieldIndex === undefined) return;
    const field = formState.item.fields?.[pickerState.fieldIndex];
    if (field && selected) {
      setFormState(current => {
        if (!current) return current;
        return {
          ...current,
          fieldIndex: pickerState.fieldIndex ?? current.fieldIndex,
          values: {...current.values, [field.name]: selected.value},
          cursor: selected.value.length
        };
      });
    }
    setPickerState(null);
  };

  const moveFormField = (delta: number) => {
    setFormState(current => {
      if (!current) return current;
      const fields = current.item.fields ?? [];
      const fieldIndex = clamp(current.fieldIndex + delta, 0, Math.max(0, fields.length - 1));
      const value = current.values[fields[fieldIndex]?.name ?? ''] ?? '';
      return {...current, fieldIndex, cursor: Math.min(value.length, current.cursor)};
    });
  };

  const updateFormValue = (nextValue: string, nextCursor?: number) => {
    setFormState(current => {
      if (!current) return current;
      const field = current.item.fields?.[current.fieldIndex];
      if (!field) return current;
      return {
        ...current,
        values: {...current.values, [field.name]: nextValue},
        cursor: clamp(nextCursor ?? current.cursor, 0, nextValue.length)
      };
    });
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

  useEffect(() => {
    const rememberRawInput = (data: Buffer | string) => {
      rawInputRef.current = String(data);
    };
    stdin.on('data', rememberRawInput);
    return () => {
      stdin.off('data', rememberRawInput);
    };
  }, [stdin]);

  useEffect(() => {
    if (!busyLabel && !pickerState?.loading) return;
    const timer = setInterval(() => setBusyTick(value => value + 1), 140);
    return () => clearInterval(timer);
  }, [busyLabel, pickerState?.loading]);

  useInput((input, key) => {
    if (pickerState) {
      if (key.escape) {
        setPickerState(null);
        return;
      }
      if (pickerState.loading || pickerState.error || pickerState.options.length === 0) {
        if (key.return) setPickerState(null);
        return;
      }
      const columns = 2;
      if (key.leftArrow) {
        setPickerState(current => current ? {...current, selectedIndex: Math.max(0, current.selectedIndex - 1)} : current);
        return;
      }
      if (key.rightArrow) {
        setPickerState(current => current ? {...current, selectedIndex: Math.min(current.options.length - 1, current.selectedIndex + 1)} : current);
        return;
      }
      if (key.upArrow) {
        setPickerState(current => current ? {...current, selectedIndex: Math.max(0, current.selectedIndex - columns)} : current);
        return;
      }
      if (key.downArrow) {
        setPickerState(current => current ? {...current, selectedIndex: Math.min(current.options.length - 1, current.selectedIndex + columns)} : current);
        return;
      }
      if (key.return) {
        void confirmPicker();
        return;
      }
      return;
    }

    if (formState) {
      const fields = formState.item.fields ?? [];
      const field = fields[formState.fieldIndex];
      const fieldValue = field ? formState.values[field.name] ?? '' : '';
      const deleteAction = sqlDeleteAction(input, key, rawInputRef.current);

      if (key.escape) {
        setFormState(null);
        return;
      }
      if (key.tab) {
        if (formState.tab === 'vars' && field?.lookup) {
          void openFieldPicker();
          return;
        }
        setFormState(current => current ? {...current, tab: current.tab === 'vars' ? 'preview' : 'vars'} : current);
        return;
      }
      if (key.ctrl && input === 'r') {
        submitForm();
        return;
      }
      if (formState.tab === 'preview') {
        if (key.return) submitForm();
        if (key.leftArrow) setFormState(current => current ? {...current, tab: 'vars'} : current);
        return;
      }
      if (key.return || key.downArrow) {
        moveFormField(1);
        return;
      }
      if (key.upArrow) {
        moveFormField(-1);
        return;
      }
      const finiteOptions = formFieldOptions(field);
      if (key.leftArrow && finiteOptions) {
        updateFormValue(cycleFormOption(field, fieldValue, -1));
        return;
      }
      if (key.rightArrow && finiteOptions) {
        updateFormValue(cycleFormOption(field, fieldValue, 1));
        return;
      }
      if (key.leftArrow) {
        setFormState(current => current ? {...current, cursor: Math.max(0, current.cursor - 1)} : current);
        return;
      }
      if (key.rightArrow) {
        setFormState(current => current ? {...current, cursor: Math.min(fieldValue.length, current.cursor + 1)} : current);
        return;
      }
      if (finiteOptions && input === ' ') {
        updateFormValue(cycleFormOption(field, fieldValue, 1));
        return;
      }
      if (deleteAction) {
        if (deleteAction === 'backward' && formState.cursor > 0) {
          updateFormValue(fieldValue.slice(0, formState.cursor - 1) + fieldValue.slice(formState.cursor), formState.cursor - 1);
        }
        if (deleteAction === 'forward' && formState.cursor < fieldValue.length) {
          updateFormValue(fieldValue.slice(0, formState.cursor) + fieldValue.slice(formState.cursor + 1), formState.cursor);
        }
        return;
      }
      if (input && field?.kind !== 'boolean') {
        const text = normalizePaste(input);
        updateFormValue(fieldValue.slice(0, formState.cursor) + text + fieldValue.slice(formState.cursor), formState.cursor + text.length);
      }
      return;
    }

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
      const deleteAction = sqlDeleteAction(input, key, rawInputRef.current);
      if (deleteAction) {
        if (deleteAction === 'backward') {
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

    if (activeGroup) {
      if (key.escape) {
        setOpenMenu(null);
        return;
      }
      if (key.upArrow) {
        setMenuIndex(value => Math.max(0, value - 1));
        return;
      }
      if (key.downArrow) {
        setMenuIndex(value => Math.min(activeGroup.items.length - 1, value + 1));
        return;
      }
      if (key.return) {
        void runMenuItem(activeGroup.items[menuIndex]);
        return;
      }
      if (isMenuGroupKey(input)) {
        setOpenMenu(input);
        setMenuIndex(0);
        return;
      }
      const matched = activeGroup.items.find(item => item.key.toLowerCase() === input.toLowerCase());
      if (matched) {
        void runMenuItem(matched);
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
    if (input === 'o') {
      void openConnectionPicker();
      return;
    }
    if (input === 'p') {
      void openScriptPicker();
      return;
    }
    if (input === 'c') {
      setBusyLabel('requesting checkpoint');
      void gateway.checkpoint()
        .then(done => setStatus(done.message))
        .then(refresh)
        .catch(error => setStatus(String(error)))
        .finally(() => setBusyLabel(null));
      return;
    }
    if (input === 'i') {
      setSqlMode(true);
      return;
    }
    if (isMenuGroupKey(input)) {
      setOpenMenu(input);
      setMenuIndex(0);
      return;
    }
    if (key.upArrow) setScrollY(value => Math.max(0, value - 1));
    if (key.downArrow) setScrollY(value => value + 1);
    if ((key as any).pageUp) setScrollY(value => Math.max(0, value - 10));
    if ((key as any).pageDown) setScrollY(value => value + 10);
    if (key.leftArrow) moveHorizontal(-1);
    if (key.rightArrow) moveHorizontal(1);
  });

  const terminalWidth = process.stdout.columns || 140;
  const terminalHeight = process.stdout.rows || 36;
  const outputWidth = Math.max(60, terminalWidth - 4);
  const outputHeight = clamp(Math.floor((terminalHeight - 14) * 0.65), 8, 16);
  const output = result?.output ?? welcome(snapshot, lang);
  const title = result ? `${localizedTitle(result, probes, lang)}  ${result.sql}` : copy[lang].output;

  return (
    <Box flexDirection="column">
      <TopBar snapshot={snapshot} status={status} lang={lang} groups={groups} activeGroup={activeGroup} menuIndex={menuIndex} />
      <Box height={1}><Text color={dimAmber}>{'-'.repeat(outputWidth)}</Text></Box>
      {pickerState ? (
        <ChoicePickerModal picker={pickerState} tick={busyTick} width={outputWidth} height={outputHeight} />
      ) : formState ? (
        <ActionFormModal form={formState} width={outputWidth} height={outputHeight} />
      ) : sqlMode ? (
        <SqlEditorModal sql={sql} cursor={sqlCursor} width={outputWidth} height={outputHeight} lang={lang} />
      ) : busyLabel ? (
        <LoadingPanel label={busyLabel} tick={busyTick} width={outputWidth} height={outputHeight} />
      ) : (
        <OutputPanel title={title} output={output} width={outputWidth} height={outputHeight} scrollX={scrollX} scrollY={scrollY} />
      )}
      <Footer sqlMode={sqlMode} formMode={Boolean(formState)} pickerMode={Boolean(pickerState)} menuMode={Boolean(activeGroup)} lang={lang} />
    </Box>
  );
}

function TopBar({snapshot, status, lang, groups, activeGroup, menuIndex}: {snapshot: Snapshot | null; status: string; lang: Lang; groups: MenuGroup[]; activeGroup: MenuGroup | null; menuIndex: number}) {
  const c = copy[lang];
  const title = snapshot ? `${c.title} // ${snapshot.container}` : c.title;
  const version = snapshot?.server_version.split(',')[0] ?? c.waiting;
  return (
    <Box flexDirection="column">
      {logoLines.map((line, index) => <Text key={line} color={logoColor(index)} bold>{line}</Text>)}
      <Text color={magenta}>{title.toUpperCase()}  <Text color={cyan}>//</Text>  <Text color={dimAmber}>{version}</Text></Text>
      <Text color={phosphor}>{version}</Text>
      <Text color={dimAmber}>{snapshot?.collected_at ?? '--'}  STATUS={status}</Text>
      <Text color={amber}>{metricsLine(snapshot, lang)}</Text>
      <Text color={amber}>{groups.map(group => `[${group.key}] ${group.title}`).join('  ')}  [o] CONNECT  [p] SCRIPTS  [i] SQL  [r] REFRESH</Text>
      {activeGroup ? <MenuDropdown group={activeGroup} selectedIndex={menuIndex} /> : null}
    </Box>
  );
}

function MenuDropdown({group, selectedIndex}: {group: MenuGroup; selectedIndex: number}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={amber} paddingX={1} width={74}>
      <Text color={amber} bold>{`[${group.key}] ${group.title}`}</Text>
      {group.items.map((item, index) => {
        const marker = index === selectedIndex ? '>' : ' ';
        return (
          <Text key={item.key} color={index === selectedIndex ? phosphor : dimAmber}>
            {`${marker} ${padDisplayEnd(item.key, 2)} ${padDisplayEnd(item.label, 20)} ${item.description}`}
          </Text>
        );
      })}
      <Text color={dimAmber}>↑/↓ select  Enter run  shortcut key run  Esc close</Text>
    </Box>
  );
}

function OutputPanel({title, output, width, height, scrollX, scrollY}: {title: string; output: string; width: number; height: number; scrollX: number; scrollY: number}) {
  const table = parseAsciiTable(output);
  if (table) {
    return <SmartTablePanel title={title} table={table} width={width} height={height} expandX={scrollX} scrollY={scrollY} />;
  }

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
      <Text color={amber} bold>{clipMono(title, startX, innerWidth)}</Text>
      {visible.map((line, index) => (
        <OutputLine key={index} line={line} startX={startX} width={innerWidth} />
      ))}
      {Array.from({length: Math.max(0, height - visible.length)}).map((_, index) => <Text key={`blank-${index}`}> </Text>)}
      <Text color={cyan}>{`Scroll ↑/↓ PgUp/PgDn  Pan ←/→   Y ${vertical}  X ${horizontal}`}</Text>
    </Box>
  );
}

function SmartTablePanel({title, table, width, height, expandX, scrollY}: {title: string; table: ParsedTable; width: number; height: number; expandX: number; scrollY: number}) {
  const innerWidth = Math.max(20, width - 4);
  const baseWidths = tableColumnBaseWidths(table);
  const naturalWidths = table.headers.map((_, index) => tableColumnNaturalWidth(table, index));
  const maxExpand = naturalWidths.reduce((total, natural, index) => total + Math.max(0, natural - (baseWidths[index] ?? natural)), 0);
  const expand = Math.min(expandX, maxExpand);
  const widths = expandedColumnWidths(baseWidths, naturalWidths, expand);
  const tableWidth = tableLineWidth(widths);
  const viewportX = Math.min(expandX, Math.max(0, tableWidth - innerWidth));
  const dataHeight = Math.max(1, height - 5 - Math.min(2, table.notes.length));
  const startY = Math.min(scrollY, Math.max(0, table.rows.length - dataHeight));
  const visibleRows = table.rows.slice(startY, startY + dataHeight);
  const rule = tableRule(widths);
  const rendered = [
    rule,
    tableRow(table.headers, widths),
    rule,
    ...visibleRows.map(row => tableRow(row, widths)),
    rule
  ];
  const notes = table.notes.slice(0, Math.max(0, height - rendered.length - 2));
  const vertical = `${startY + 1}-${Math.min(table.rows.length, startY + dataHeight)}/${Math.max(1, table.rows.length)}`;
  const maxHorizontal = Math.max(maxExpand, Math.max(0, tableLineWidth(naturalWidths) - innerWidth));
  const horizontal = maxHorizontal > 0 ? `${Math.min(expandX, maxHorizontal)}/${maxHorizontal}` : 'full';

  return (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor={dimAmber} paddingX={1}>
      <Text color={amber} bold>{clipMono(title, 0, innerWidth)}</Text>
      {rendered.slice(0, height - 1).map((line, index) => <TableOutputLine key={index} line={line} startX={viewportX} width={innerWidth} />)}
      {notes.map((note, index) => <Text key={`note-${index}`} color={dimAmber}>{clipMono(note, 0, innerWidth)}</Text>)}
      {Array.from({length: Math.max(0, height - rendered.length - notes.length)}).map((_, index) => <Text key={`blank-${index}`}> </Text>)}
      <Text color={cyan}>{`Scroll ↑/↓ PgUp/PgDn  Width ←/→ fast   Y ${vertical}  X ${horizontal}`}</Text>
    </Box>
  );
}

function LoadingPanel({label, tick, width, height}: {label: string; tick: number; width: number; height: number}) {
  const innerWidth = Math.max(20, width - 4);
  const frames = ['[=     ]', '[==    ]', '[===   ]', '[ ==== ]', '[  === ]', '[   == ]', '[    =]'];
  const frame = frames[tick % frames.length] ?? frames[0];
  const dots = '.'.repeat(tick % 4).padEnd(3, ' ');
  const pulse = tick % 2 === 0 ? cyan : magenta;
  const topPad = Math.max(1, Math.floor((height - 5) / 2));

  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={pulse} paddingX={1}>
      {Array.from({length: topPad}).map((_, index) => <Text key={`load-top-${index}`}> </Text>)}
      <Text color={pulse} bold>{sliceMono(`READING ${frame}`, 0, innerWidth)}</Text>
      <Text color={phosphor}>{sliceMono(`${label}${dots}`, 0, innerWidth)}</Text>
      <Text color={dimAmber}>{sliceMono('waiting for PostgreSQL / Docker metrics; UI remains responsive', 0, innerWidth)}</Text>
      {Array.from({length: Math.max(0, height - topPad - 3)}).map((_, index) => <Text key={`load-bottom-${index}`}> </Text>)}
      <Text color={cyan}>Result will replace this panel when ready</Text>
    </Box>
  );
}

function OutputLine({line, startX, width}: {line: string; startX: number; width: number}) {
  const rendered = clipMono(line, startX, width);
  return <Text color={outputLineColor(line)}>{rendered}</Text>;
}

function TableOutputLine({line, startX, width}: {line: string; startX: number; width: number}) {
  const rendered = sliceMono(line, startX, width);
  return <Text color={outputLineColor(line)}>{rendered}</Text>;
}

function ActionFormModal({form, width, height}: {form: FormState; width: number; height: number}) {
  const modalWidth = Math.min(width, 112);
  const modalHeight = Math.min(height, 18);
  const marginLeft = Math.max(0, Math.floor((width - modalWidth) / 2));
  const marginTop = Math.max(0, Math.floor((height - modalHeight) / 2));
  const fields = form.item.fields ?? [];
  const bodyHeight = Math.max(5, modalHeight - 7);
  const sql = form.item.buildSql?.(form.values) ?? '';
  const previewLines = sql.split('\n').slice(0, bodyHeight);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {Array.from({length: marginTop}).map((_, index) => <Text key={`form-top-${index}`}> </Text>)}
      <Box marginLeft={marginLeft} flexDirection="column" width={modalWidth} borderStyle="double" borderColor={amber} paddingX={1}>
        <Text color={amber} bold>{form.item.label}</Text>
        <Text color={dimAmber}>{form.item.description}</Text>
        <Text color={amber}>{`${form.tab === 'vars' ? '[Variables]' : ' Variables '}  ${form.tab === 'preview' ? '[SQL Preview]' : ' SQL Preview '}`}</Text>
        {form.tab === 'vars' ? (
          <>
            {fields.slice(0, bodyHeight).map((field, index) => (
              <Text key={field.name}>
                <Text color={index === form.fieldIndex ? amber : dimAmber}>{`${index === form.fieldIndex ? '>' : ' '} ${padDisplayEnd(field.label, 16)} `}</Text>
                <FormFieldValue field={field} value={form.values[field.name] ?? ''} active={index === form.fieldIndex} cursor={form.cursor} width={modalWidth - 24} />
                {field.lookup && index === form.fieldIndex ? <Text color={dimAmber}>  Tab...</Text> : null}
              </Text>
            ))}
            {Array.from({length: Math.max(0, bodyHeight - fields.length)}).map((_, index) => <Text key={`form-blank-${index}`}> </Text>)}
          </>
        ) : (
          <>
            {previewLines.map((line, index) => (
            <Text key={index}><HighlightedSql text={clipMono(line, 0, modalWidth - 5)} /></Text>
            ))}
            {Array.from({length: Math.max(0, bodyHeight - previewLines.length)}).map((_, index) => <Text key={`sql-blank-${index}`}> </Text>)}
          </>
        )}
        <Text color={dimAmber}>Tab lookup/tab  ↑/↓ field  ←/→ option  Space toggle  Ctrl+R run  Esc close</Text>
      </Box>
    </Box>
  );
}

function ChoicePickerModal({picker, tick, width, height}: {picker: PickerState; tick: number; width: number; height: number}) {
  const modalWidth = Math.min(width, 104);
  const modalHeight = Math.min(height, 18);
  const marginLeft = Math.max(0, Math.floor((width - modalWidth) / 2));
  const marginTop = Math.max(0, Math.floor((height - modalHeight) / 2));
  const bodyHeight = Math.max(4, modalHeight - 6);
  const columns = 2;
  const columnWidth = Math.max(24, Math.floor((modalWidth - 6) / columns));
  const rows = Math.ceil(Math.min(picker.options.length, bodyHeight * columns) / columns);
  const selected = picker.options[picker.selectedIndex];
  const hint = picker.mode === 'field'
    ? '↑/↓/←/→ choose  Enter confirm  Esc cancel  manual input remains available'
    : '↑/↓/←/→ choose  Enter confirm/run  Esc cancel';

  return (
    <Box flexDirection="column" width={width} height={height}>
      {Array.from({length: marginTop}).map((_, index) => <Text key={`picker-top-${index}`}> </Text>)}
      <Box marginLeft={marginLeft} flexDirection="column" width={modalWidth} borderStyle="double" borderColor={amber} paddingX={1}>
        <Text color={amber} bold>{`Select ${picker.title}`}</Text>
        <Text color={dimAmber}>{hint}</Text>
        {picker.loading ? <Text color={cyan}>{`loading candidates${'.'.repeat(tick % 4).padEnd(3, ' ')}`}</Text> : null}
        {picker.error ? <Text color={phosphor}>{picker.error}</Text> : null}
        {!picker.loading && !picker.error && picker.options.length === 0 ? <Text color={phosphor}>no candidates found</Text> : null}
        {!picker.loading && !picker.error ? Array.from({length: rows}).map((_, row) => (
          <Text key={row}>
            {Array.from({length: columns}).map((__, column) => {
              const index = row * columns + column;
              const option = picker.options[index];
              if (!option) return <Text key={column}>{' '.repeat(columnWidth)}</Text>;
              const active = index === picker.selectedIndex;
              const activeConnection = option.active ? '*' : ' ';
              return (
                <Text key={option.value} color={active ? amber : phosphor}>
                  {clipMono(`${active ? '>' : ' '} ${activeConnection} ${option.label}`, 0, columnWidth)}
                </Text>
              );
            })}
          </Text>
        )) : null}
        {selected ? <Text color={dimAmber}>{clipMono(selected.description, 0, modalWidth - 4)}</Text> : null}
      </Box>
    </Box>
  );
}

function FormFieldValue({field, value, active, cursor, width}: {field: FormField; value: string; active: boolean; cursor: number; width: number}) {
  const options = formFieldOptions(field);
  const optionLabel = options?.find(option => option.value === normalizedOptionValue(field, value))?.label;
  const rendered = optionLabel ?? (field.kind === 'password' ? '*'.repeat(value.length) : value);
  const placeholder = value ? '' : field.placeholder ?? '';
  const text = rendered || placeholder;
  if (options) {
    const optionText = active ? `< ${rendered} >` : rendered;
    return <Text color={active ? amber : phosphor}>{sliceMono(optionText, 0, width)}</Text>;
  }
  if (!active) {
    return <Text color={value ? phosphor : dimAmber}>{sliceMono(text, 0, width)}</Text>;
  }
  const shownCursor = clamp(cursor, 0, rendered.length);
  const before = rendered.slice(0, shownCursor);
  const char = rendered[shownCursor] ?? ' ';
  const after = rendered.slice(shownCursor + 1);
  return (
    <>
      <Text color={phosphor}>{sliceMono(before, 0, Math.min(before.length, width))}</Text>
      <Text color="#1b1605" backgroundColor={amber}>{char}</Text>
      <Text color={phosphor}>{sliceMono(after, 0, Math.max(0, width - before.length - 1))}</Text>
    </>
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

function Footer({sqlMode, formMode, pickerMode, menuMode, lang}: {sqlMode: boolean; formMode: boolean; pickerMode: boolean; menuMode: boolean; lang: Lang}) {
  const text = pickerMode
    ? '↑/↓/←/→ choose  Enter confirm  Esc cancel'
    : formMode
      ? 'Tab lookup/tab  ↑/↓ fields  ←/→ options  Ctrl+R run  Esc close'
    : menuMode
      ? '1-4 switch menu  ↑/↓ choose  Enter run  shortcut key run  Esc close'
      : sqlMode
        ? copy[lang].sqlFooter
        : `${copy[lang].footer}  o connect  p scripts`;
  return (
    <Box height={1}>
      <Text color={dimAmber}>{text}</Text>
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

function logoColor(index: number): string {
  return [cyan, amber, magenta, amber, cyan][index] ?? amber;
}

function outputLineColor(line: string): string {
  const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
  const status = cells.length >= 5 ? cells[3] : '';
  if (status === 'CRIT') return red;
  if (status === 'WARN' || status === 'WATCH') return '#ff9f43';
  if (status === 'OK') return green;
  if (status === 'INFO') return cyan;
  if (/\bCRIT\b|ERROR|SQL error/i.test(line)) return red;
  if (/\bWARN\b|\bWATCH\b/i.test(line)) return '#ff9f43';
  if (/\bINFO\b/i.test(line)) return cyan;
  if (/^\+[-+]+\+$/.test(line) || /Scroll|Y \d|X \d/.test(line)) return cyan;
  if (/^\| Item\b|^\| Current\b|Reference|Status|Meaning/.test(line)) return amber;
  return phosphor;
}

function parseAsciiTable(output: string): ParsedTable | null {
  const lines = output.replace(/\t/g, '    ').split('\n');
  const rowLines = lines.filter(line => isAsciiTableRow(line));
  if (rowLines.length < 2) return null;
  const headers = splitAsciiTableRow(rowLines[0] ?? '');
  const rows = rowLines.slice(1).map(splitAsciiTableRow).filter(row => row.length > 0);
  if (!headers.length || !rows.length) return null;
  const notes = lines.filter(line => {
    const trimmed = line.trim();
    return trimmed && !isAsciiTableRow(line) && !/^\+[-+]+\+$/.test(trimmed);
  });
  return {headers, rows, notes};
}

function isAsciiTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

function splitAsciiTableRow(line: string): string[] {
  return line.split('|').slice(1, -1).map(cell => cell.trim());
}

function tableColumnBaseWidths(table: ParsedTable): number[] {
  return table.headers.map((header, index) => {
    const natural = tableColumnNaturalWidth(table, index);
    const cap = tableColumnCap(index, table.headers.length);
    return Math.max(monoDisplayWidth(header), Math.min(natural, cap));
  });
}

function tableColumnNaturalWidth(table: ParsedTable, index: number): number {
  return Math.max(
    monoDisplayWidth(table.headers[index] ?? ''),
    ...table.rows.map(row => monoDisplayWidth(row[index] ?? ''))
  );
}

function tableColumnCap(index: number, count: number): number {
  if (count >= 5 && index === count - 1) return 44;
  if (count >= 5 && index === 2) return 38;
  if (count >= 5 && index === 3) return 8;
  if (index === 0) return 18;
  return 30;
}

function expandedColumnWidths(baseWidths: number[], naturalWidths: number[], expand: number): number[] {
  const widths = [...baseWidths];
  let cursor = 0;
  for (let remaining = expand; remaining > 0;) {
    let changed = false;
    for (let scanned = 0; scanned < widths.length && remaining > 0; scanned++) {
      const index = (cursor + scanned) % widths.length;
      const room = Math.max(0, (naturalWidths[index] ?? widths[index] ?? 0) - (widths[index] ?? 0));
      if (room <= 0) continue;
      widths[index] = (widths[index] ?? 0) + 1;
      remaining -= 1;
      cursor = (index + 1) % widths.length;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return widths;
}

function tableLineWidth(widths: number[]): number {
  return widths.reduce((total, width) => total + width + 3, 1);
}

function tableRule(widths: number[]): string {
  return `+${widths.map(width => '-'.repeat(width + 2)).join('+')}+`;
}

function tableRow(cells: string[], widths: number[]): string {
  const rendered = widths.map((width, index) => ` ${clipCell(cells[index] ?? '', width)} `);
  return `|${rendered.join('|')}|`;
}

function clipCell(value: string, width: number): string {
  if (monoDisplayWidth(value) <= width) return padDisplayEnd(value, width);
  if (width <= 3) return '.'.repeat(width);
  return `${value.slice(0, width - 3)}...`;
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

function isMenuGroupKey(value: string): value is MenuGroupKey {
  return value === '1' || value === '2' || value === '3' || value === '4';
}

function isTrue(value: string): boolean {
  return value === 'true' || value === 'on' || value === '1' || value === 'yes';
}

function formFieldOptions(field: FormField | undefined): FormOption[] | null {
  if (!field) return null;
  if (field.options?.length) return field.options;
  if (field.kind === 'boolean') {
    return [
      {label: 'OFF', value: 'false'},
      {label: 'ON', value: 'true'}
    ];
  }
  return null;
}

function normalizedOptionValue(field: FormField | undefined, value: string): string {
  if (field?.kind === 'boolean') {
    return isTrue(value) ? 'true' : 'false';
  }
  return value;
}

function cycleFormOption(field: FormField | undefined, value: string, delta: number): string {
  const options = formFieldOptions(field);
  if (!options?.length) return value;
  const normalized = normalizedOptionValue(field, value);
  const currentIndex = Math.max(0, options.findIndex(option => option.value === normalized));
  const nextIndex = (currentIndex + delta + options.length) % options.length;
  return options[nextIndex]?.value ?? value;
}

function tablePrivilegeOptions(): FormOption[] {
  return [
    {label: 'READ_ONLY', value: 'SELECT'},
    {label: 'DML', value: 'INSERT, UPDATE, DELETE'},
    {label: 'READ_WRITE', value: 'SELECT, INSERT, UPDATE, DELETE'},
    {label: 'ALL', value: 'ALL PRIVILEGES'}
  ];
}

function boolSql(value: string, positive: string, negative: string): string {
  return isTrue(value) ? positive : negative;
}

function sqlIdent(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z_][a-z0-9_]*$/i.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlInteger(value: string): string {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? String(parsed) : '0';
}

function sqlPrivilegeList(value: string): string {
  const allowed = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']);
  const privileges = value
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(item => allowed.has(item));
  return privileges.length ? privileges.join(', ') : 'SELECT';
}

function sqlPrivilegePreset(value: string): string {
  if (value === 'ALL PRIVILEGES') return value;
  return sqlPrivilegeList(value);
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

function sqlDeleteAction(input: string, key: any, rawInput: string): 'backward' | 'forward' | null {
  if (key.ctrl && input === 'd') {
    return 'forward';
  }
  if (key.ctrl && input === 'h' || key.backspace || key.backspaceKey || input === '\b' || rawInput === '\b' || rawInput === '\x7f') {
    return 'backward';
  }
  if (isRawDeleteSequence(rawInput) || key.delete || key.deleteKey || key.name === 'delete' || input === '\x1b[3~') {
    return 'forward';
  }
  return null;
}

function isRawDeleteSequence(value: string): boolean {
  return value === '\x1b[3~' || value === '\x1b[3$' || value === '\x1b[3^' || /^\x1b\[3;\d+(?::\d+)?~$/.test(value);
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

function clipMono(value: string, start: number, width: number): string {
  if (width <= 0) return '';
  const maxStart = Math.max(0, value.length - width);
  const safeStart = Math.min(start, maxStart);
  if (value.length <= width) return value.padEnd(width, ' ');
  if (safeStart === 0) {
    return `${value.slice(0, Math.max(0, width - 3))}...`;
  }
  if (safeStart >= maxStart) {
    return `...${value.slice(value.length - Math.max(0, width - 3))}`;
  }
  return `...${value.slice(safeStart + 3, safeStart + width)}`;
}

function padDisplayEnd(value: string, width: number): string {
  const displayWidth = monoDisplayWidth(value);
  return displayWidth >= width ? value : `${value}${' '.repeat(width - displayWidth)}`;
}

function monoDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += /[^\u0000-\u00ff]/.test(char) ? 2 : 1;
  }
  return width;
}

function spacedTitle(value: string): string {
  return value.toUpperCase().split('').join(' ');
}

render(<App />);
