/* Illustrative data only. This website never connects to a server. */
(() => {
  'use strict';
  const tabs = [...document.querySelectorAll('[data-view]')];
  const panel = document.getElementById('panel');
  const views = {
    terminal: ['>_ SSH 终端', `<div class="muted">Connected to web-server-01 via SSH<br>Ubuntu 24.04 LTS · Welcome to your workspace.</div><div class="command">root@web-server-01 <b>:~# docker ps</b></div><div class="output">CONTAINER ID &nbsp; IMAGE &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; STATUS<br><span>a8f32c7d910e</span> &nbsp; nginx:stable &nbsp; Up 3 days<br><span>b7e21d6c802f</span> &nbsp; redis:7 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Up 3 days</div><div class="command">root@web-server-01 <b>:~# systemctl status nginx</b></div><div class="output"><span>●</span> nginx.service — A high performance web server<br>&nbsp; Active: <span>active (running)</span></div><div class="command">root@web-server-01 <b>:~#</b><span class="block-cursor"></span></div>`],
    monitor: ['↗ 实时监控', `<div class="muted">web-server-01 / 资源概览 · 演示数据</div><div class="metrics"><div class="metric"><label>CPU 使用率</label><strong>12.8<small> %</small></strong><small>4 vCPU</small><div class="bar"><i style="width:13%"></i></div></div><div class="metric"><label>内存使用</label><strong>2.4<small> GB</small></strong><small>共 8 GB</small><div class="bar"><i style="width:30%"></i></div></div><div class="metric"><label>磁盘使用</label><strong>36<small> %</small></strong><small>36 / 100 GB</small><div class="bar"><i style="width:36%"></i></div></div></div><div class="monitor-foot">↓ 网络接收 &nbsp; 128 KB/s &nbsp; ↑ 网络发送 &nbsp; 64 KB/s<br>运行时间 &nbsp; 3 days, 08:42 · 进程数 &nbsp; 124</div>`],
    files: ['▤ 远程文件', `<div class="muted">SFTP / var / www / app</div><table class="files"><thead><tr><th>名称</th><th>大小</th><th>权限</th></tr></thead><tbody><tr><td>▸ public/</td><td>—</td><td>drwxr-xr-x</td></tr><tr><td>▸ src/</td><td>—</td><td>drwxr-xr-x</td></tr><tr><td>◇ index.html</td><td>2.4 KB</td><td>-rw-r--r--</td></tr><tr><td>◇ package.json</td><td>1.2 KB</td><td>-rw-r--r--</td></tr><tr><td>◇ nginx.conf</td><td>856 B</td><td>-rw-r--r--</td></tr></tbody></table><div class="monitor-foot">远程目录与终端 cd 联动 · 支持文件上传与文本编辑</div>`]
  };
  function select(tab, focus = false) {
    tabs.forEach(t => {t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1;});
    const view = views[tab.dataset.view];
    document.getElementById('demo-title').textContent = view[0];
    panel.innerHTML = view[1];
    panel.setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) {event.preventDefault(); select(tabs[next], true);}
    });
  });
  select(tabs[0]);
  document.getElementById('year').textContent = new Date().getFullYear();
})();
