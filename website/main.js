(() => {
  'use strict';
  const tabs = [...document.querySelectorAll('[data-product]')];
  const screenshot = document.getElementById('hero-screenshot');
  const panel = document.getElementById('product-panel');
  const viewer = document.getElementById('image-viewer');
  const viewerImage = document.getElementById('viewer-image');
  const products = {
    ssh: {src:'assets/ssh.png', alt:'BLS-OPS 真实服务器界面：左侧服务器列表，中间 SSH 终端，右侧远程文件浏览器', caption:'SSH 终端与远程文件。', label:'服务器工作台'},
    sql: {src:'assets/sql.png', alt:'BLS-OPS 真实数据库界面：数据库导航、表数据浏览与 SQL 查询工具栏', caption:'SQL 查询与库表管理。', label:'数据库工作台'}
  };
  // Preload the alternate screenshot so switching is immediate.
  const alternate = new Image();
  alternate.src = products.sql.src;
  function select(tab, focus = false) {
    tabs.forEach(item => {const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;});
    const product = products[tab.dataset.product];
    screenshot.src = product.src;
    screenshot.parentElement.querySelector('.privacy-mask').toggleAttribute('hidden', tab.dataset.product !== 'ssh');
    screenshot.alt = product.alt;
    screenshot.parentElement.setAttribute('aria-label', '放大' + product.label + '截图');
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
  document.querySelectorAll('[data-zoom]').forEach(button => {
    button.addEventListener('click', () => {
      const image = button.querySelector('img');
      viewerImage.src = image.src;
      viewerImage.alt = image.alt;
      viewerImage.parentElement.querySelector('.privacy-mask').toggleAttribute('hidden', !image.getAttribute('src').endsWith('/ssh.png'));
      document.getElementById('viewer-title').textContent = image.alt;
      viewer.showModal();
      document.body.style.overflow = 'hidden';
    });
  });
  const close = () => viewer.close();
  document.getElementById('close-viewer').addEventListener('click', close);
  viewer.addEventListener('click', event => {if(event.target === viewer) {const rect = viewer.getBoundingClientRect(); if(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();}});
  viewer.addEventListener('close', () => {document.body.style.overflow = '';});
  document.getElementById('year').textContent = new Date().getFullYear();
})();
