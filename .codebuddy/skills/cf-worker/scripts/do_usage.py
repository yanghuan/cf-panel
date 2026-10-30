#!/usr/bin/env python3
"""cf-panel Durable Objects 用量查询（无第三方依赖）。

用法：
  python3 do_usage.py                 # 最近 2 天，按小时
  python3 do_usage.py --days 1        # 最近 1 天
  python3 do_usage.py --by-class      # 追加按 DO 类聚合
  python3 do_usage.py --by-object     # 追加按分片对象聚合（仅 TerminalDO 有意义）

凭证从 skill 目录的 .env 读取（CF_API_TOKEN / CF_ACCOUNT_ID / CF_SCRIPT_NAME）。

输出中的 `dur/req` 是单请求折算的驻留时间：正常 0.4–0.6 秒；明显偏高说明对象
处于 non-hibernateable 状态（空闲但拿不到 hibernation 资格），按 70–140 秒 evict 规则计费。
未走完的当前小时会标 `*` 并按已过分钟外推到整小时。
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(SKILL_DIR, '.env')
GB_PER_OBJECT = 0.128  # DO 固定按 128MB 计费


def load_env(path):
    if not os.path.exists(path):
        sys.exit(f'未找到 {path}（复制 .env.example 并填入凭证）')
    env = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def api_get(path, token):
    req = urllib.request.Request(
        f'https://api.cloudflare.com/client/v4{path}',
        headers={'Authorization': f'Bearer {token}'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def gql(query, token):
    body = json.dumps({'query': query}).encode()
    req = urllib.request.Request(
        'https://api.cloudflare.com/client/v4/graphql',
        data=body,
        headers={'Authorization': f'Bearer {token}', 'content-type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f'GraphQL HTTP {e.code}: {e.read()[:300]}')
    if data.get('errors'):
        sys.exit('GraphQL 报错：' + json.dumps(data['errors'], ensure_ascii=False))
    return data['data']['viewer']['accounts'][0]


def namespace_map(acc, script, token):
    s = api_get(f'/accounts/{acc}/workers/scripts/{script}/settings', token)['result']
    return {
        b['namespace_id']: b['class_name']
        for b in s.get('bindings', [])
        if b.get('type') == 'durable_object_namespace'
    }


def hourly(acc, start, end, token):
    q = f'''query {{
      viewer {{ accounts(filter: {{accountTag: "{acc}"}}) {{
        d: durableObjectsPeriodicGroups(limit: 400,
             filter: {{date_geq: "{start}", date_leq: "{end}"}},
             orderBy: [datetimeHour_ASC]) {{
          dimensions {{ datetimeHour }} sum {{ duration }}
        }}
        r: durableObjectsInvocationsAdaptiveGroups(limit: 400,
             filter: {{date_geq: "{start}", date_leq: "{end}"}},
             orderBy: [datetimeHour_ASC]) {{
          dimensions {{ datetimeHour }} sum {{ requests }}
        }}
      }} }}
    }}'''
    a = gql(q, token)
    d = {x['dimensions']['datetimeHour']: x['sum']['duration'] for x in a['d']}
    r = {x['dimensions']['datetimeHour']: x['sum']['requests'] for x in a['r']}
    return d, r


def by_class(acc, start, end, token):
    q = f'''query {{
      viewer {{ accounts(filter: {{accountTag: "{acc}"}}) {{
        d: durableObjectsPeriodicGroups(limit: 100,
             filter: {{date_geq: "{start}", date_leq: "{end}"}},
             orderBy: [namespaceId_ASC]) {{
          dimensions {{ namespaceId }} sum {{ duration }}
        }}
        r: durableObjectsInvocationsAdaptiveGroups(limit: 100,
             filter: {{date_geq: "{start}", date_leq: "{end}"}},
             orderBy: [namespaceId_ASC]) {{
          dimensions {{ namespaceId }} sum {{ requests }}
        }}
      }} }}
    }}'''
    a = gql(q, token)
    d = {x['dimensions']['namespaceId']: x['sum']['duration'] for x in a['d']}
    r = {x['dimensions']['namespaceId']: x['sum']['requests'] for x in a['r']}
    return d, r


def by_object(acc, start, end, namespace_id, token):
    q = f'''query {{
      viewer {{ accounts(filter: {{accountTag: "{acc}"}}) {{
        durableObjectsPeriodicGroups(limit: 200,
          filter: {{date_geq: "{start}", date_leq: "{end}", namespaceId: "{namespace_id}"}},
          orderBy: [objectId_ASC]) {{
          dimensions {{ objectId }} sum {{ duration }}
        }}
      }} }}
    }}'''
    a = gql(q, token)
    return {x['dimensions']['objectId']: x['sum']['duration'] for x in a['durableObjectsPeriodicGroups']}


def main():
    ap = argparse.ArgumentParser(description='查询 cf-panel 的 DO 用量')
    ap.add_argument('--days', type=int, default=2, help='回溯天数（默认 2）')
    ap.add_argument('--by-class', action='store_true', help='追加按 DO 类聚合')
    ap.add_argument('--by-object', action='store_true', help='追加按分片对象聚合')
    args = ap.parse_args()

    env = load_env(ENV_PATH)
    token = env.get('CF_API_TOKEN', '')
    acc = env.get('CF_ACCOUNT_ID', '')
    script = env.get('CF_SCRIPT_NAME', 'cf-panel')
    if not token or not acc:
        sys.exit('CF_API_TOKEN / CF_ACCOUNT_ID 未配置')

    now = datetime.now(timezone.utc)
    end = (now + timedelta(days=1)).strftime('%Y-%m-%d')
    start = (now - timedelta(days=args.days)).strftime('%Y-%m-%d')
    ns = namespace_map(acc, script, token)

    d, r = hourly(acc, start, end, token)
    print(f'== 按小时（UTC，{start} ~ {end}）==')
    print(f'{"时间":22s}{"duration":>12s}{"requests":>10s}   dur/req')
    cur_hour = now.strftime('%Y-%m-%dT%H:00:00Z')
    total_d = 0.0
    for hour in sorted(d):
        dur = d.get(hour, 0.0)
        req = r.get(hour, 0)
        mark = ''
        shown_dur = dur
        if hour == cur_hour:
            elapsed = now.minute + now.second / 60
            if elapsed >= 3:  # 太早外推没有意义
                shown_dur = dur * 60 / elapsed
            mark = f'*（外推自 {elapsed:.0f} 分钟）'
        else:
            total_d += dur
        unit = (dur / req) if req else 0
        print(f'{hour:22s}{shown_dur:12.1f}{req:10d}   {unit:.3f} GB-s ({unit / GB_PER_OBJECT:.2f}s){mark}')

    if args.by_class:
        d2, r2 = by_class(acc, start, end, token)
        print('\n== 按 DO 类 ==')
        for nid, dur in sorted(d2.items(), key=lambda kv: -kv[1]):
            req = r2.get(nid, 0)
            unit = (dur / req) if req else 0
            print(f'  {ns.get(nid, nid):12s} dur={dur:10.1f}  req={req:8d}  '
                  f'dur/req={unit:.3f} GB-s ({unit / GB_PER_OBJECT:.2f}s)')

    if args.by_object and ns:
        term = next((nid for nid, name in ns.items() if name == 'TerminalDO'), None)
        if term:
            o = by_object(acc, start, end, term, token)
            print('\n== TerminalDO 按分片对象 ==')
            for oid, dur in sorted(o.items(), key=lambda kv: -kv[1]):
                print(f'  {oid[:16]}…  dur={dur:10.1f}')


if __name__ == '__main__':
    main()
