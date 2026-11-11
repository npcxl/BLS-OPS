/**
 * CommandProvider —— 命令名补全（输入法式：敲 `unz` 就提示 `unzip`）。
 *
 * 为什么需要它：知识库只覆盖我们收录过的运维命令，敲一个拼错的 `unizp`
 * 或没收录的 `unzstd`，候选里全是无关的长命令模板 —— 看起来就是"提示的错误
 * 命令"。这里用**内置常用命令表 + 前缀匹配 + 一步拼写纠错**兜住命令名这一层，
 * 不查远端、不依赖网络，输入即时出结果。
 *
 * 边界：
 * - 只接管**命令词位置**（第 0 个 token），参数位交给各自的 Provider；
 * - 输入里带 `/` 说明在写路径，不接管；
 * - 命令词为空（还没开始敲）不接管，免得一上来就糊一屏。
 */

import { i18n } from "@/i18n";
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "../types";

interface KnownCommand {
  name: string;
  about: string;
}

/** 高频 Linux 命令（本地常量：补命令名必须**零延迟**，不能等远端）。 */
const COMMANDS: KnownCommand[] = [
  // 文件与目录
  { name: "ls", about: "列出目录内容" },
  { name: "cd", about: "切换目录" },
  { name: "pwd", about: "显示当前目录" },
  { name: "cp", about: "复制文件或目录" },
  { name: "mv", about: "移动或重命名" },
  { name: "rm", about: "删除文件或目录" },
  { name: "mkdir", about: "创建目录" },
  { name: "rmdir", about: "删除空目录" },
  { name: "touch", about: "创建空文件 / 更新时间戳" },
  { name: "ln", about: "创建链接" },
  { name: "find", about: "按条件查找文件" },
  { name: "locate", about: "按索引查找文件" },
  { name: "stat", about: "查看文件元信息" },
  { name: "file", about: "判断文件类型" },
  { name: "tree", about: "树状显示目录" },
  { name: "realpath", about: "解析绝对路径" },
  { name: "basename", about: "取路径最后一段" },
  { name: "dirname", about: "取路径所在目录" },
  { name: "install", about: "复制并设置权限" },
  { name: "rsync", about: "增量同步文件" },
  { name: "scp", about: "远程复制" },

  // 查看与编辑
  { name: "cat", about: "输出文件内容" },
  { name: "less", about: "分页查看" },
  { name: "more", about: "分页查看" },
  { name: "head", about: "查看开头几行" },
  { name: "tail", about: "查看结尾几行" },
  { name: "vim", about: "编辑文件" },
  { name: "vi", about: "编辑文件" },
  { name: "nano", about: "编辑文件" },
  { name: "grep", about: "按内容搜索" },
  { name: "egrep", about: "扩展正则搜索" },
  { name: "rg", about: "快速递归搜索" },
  { name: "sed", about: "流编辑器" },
  { name: "awk", about: "字段处理" },
  { name: "cut", about: "按列截取" },
  { name: "sort", about: "排序" },
  { name: "uniq", about: "去重" },
  { name: "tr", about: "字符替换" },
  { name: "wc", about: "统计行数/字数" },
  { name: "diff", about: "比较文件" },
  { name: "cmp", about: "逐字节比较" },
  { name: "tee", about: "输出并写文件" },
  { name: "xargs", about: "把输入作为参数" },
  { name: "jq", about: "处理 JSON" },

  // 压缩与归档
  { name: "tar", about: "打包 / 解包" },
  { name: "unzip", about: "解压 zip" },
  { name: "zip", about: "创建 zip" },
  { name: "gzip", about: "gzip 压缩" },
  { name: "gunzip", about: "gzip 解压" },
  { name: "zcat", about: "查看 gz 内容" },
  { name: "bzip2", about: "bzip2 压缩" },
  { name: "bunzip2", about: "bzip2 解压" },
  { name: "xz", about: "xz 压缩" },
  { name: "unxz", about: "xz 解压" },
  { name: "zstd", about: "zstd 压缩" },
  { name: "unzstd", about: "zstd 解压" },
  { name: "7z", about: "7z 压缩 / 解压" },
  { name: "unrar", about: "解压 rar" },

  // 系统与进程
  { name: "ps", about: "查看进程" },
  { name: "top", about: "实时进程" },
  { name: "htop", about: "交互式进程" },
  { name: "kill", about: "结束进程" },
  { name: "killall", about: "按名称结束" },
  { name: "pkill", about: "按模式结束" },
  { name: "pgrep", about: "按名称找 PID" },
  { name: "nohup", about: "脱离终端运行" },
  { name: "jobs", about: "查看后台任务" },
  { name: "bg", about: "转到后台" },
  { name: "fg", about: "转回前台" },
  { name: "free", about: "内存使用" },
  { name: "df", about: "磁盘占用" },
  { name: "du", about: "目录大小" },
  { name: "uptime", about: "运行时长与负载" },
  { name: "uname", about: "系统信息" },
  { name: "hostname", about: "主机名" },
  { name: "whoami", about: "当前用户" },
  { name: "id", about: "用户与组" },
  { name: "who", about: "登录用户" },
  { name: "last", about: "最近登录" },
  { name: "w", about: "在线用户与负载" },
  { name: "lsof", about: "打开的文件与端口" },
  { name: "ss", about: "套接字统计" },
  { name: "netstat", about: "网络连接" },
  { name: "nproc", about: "CPU 核数" },
  { name: "lscpu", about: "CPU 信息" },
  { name: "lsblk", about: "块设备" },
  { name: "mount", about: "挂载" },
  { name: "umount", about: "卸载" },
  { name: "dmesg", about: "内核日志" },

  // systemd / 服务
  { name: "systemctl", about: "服务管理" },
  { name: "journalctl", about: "日志查询" },
  { name: "service", about: "服务管理（旧）" },
  { name: "crontab", about: "定时任务" },
  { name: "systemd-analyze", about: "启动耗时分析" },

  // 网络
  { name: "curl", about: "HTTP 请求" },
  { name: "wget", about: "下载" },
  { name: "ping", about: "连通性测试" },
  { name: "traceroute", about: "路由追踪" },
  { name: "mtr", about: "路由 + 丢包" },
  { name: "dig", about: "DNS 查询" },
  { name: "nslookup", about: "DNS 查询" },
  { name: "host", about: "DNS 查询" },
  { name: "telnet", about: "端口连通性" },
  { name: "nc", about: "任意 TCP/UDP" },
  { name: "nmap", about: "端口扫描" },
  { name: "tcpdump", about: "抓包" },
  { name: "ip", about: "网络配置" },
  { name: "ifconfig", about: "网卡信息" },
  { name: "route", about: "路由表" },
  { name: "iptables", about: "防火墙" },
  { name: "firewall-cmd", about: "firewalld" },
  { name: "ufw", about: "Ubuntu 防火墙" },

  // 用户与权限
  { name: "useradd", about: "新增用户" },
  { name: "userdel", about: "删除用户" },
  { name: "usermod", about: "修改用户" },
  { name: "groupadd", about: "新增组" },
  { name: "passwd", about: "修改密码" },
  { name: "su", about: "切换用户" },
  { name: "sudo", about: "以其他用户执行" },
  { name: "chmod", about: "修改权限" },
  { name: "chown", about: "修改属主" },
  { name: "chgrp", about: "修改属组" },
  { name: "umask", about: "默认权限掩码" },

  // 包管理
  { name: "apt", about: "Debian 包管理" },
  { name: "apt-get", about: "Debian 包管理" },
  { name: "dpkg", about: "Debian 包操作" },
  { name: "yum", about: "RHEL 包管理" },
  { name: "dnf", about: "RHEL 包管理" },
  { name: "rpm", about: "RPM 包操作" },
  { name: "apk", about: "Alpine 包管理" },
  { name: "pacman", about: "Arch 包管理" },

  // 容器与编排
  { name: "docker", about: "容器管理" },
  { name: "docker-compose", about: "Compose 编排" },
  { name: "podman", about: "容器管理" },
  { name: "kubectl", about: "Kubernetes" },
  { name: "helm", about: "Kubernetes 包管理" },
  { name: "nerdctl", about: "containerd CLI" },

  // 其他常用
  { name: "echo", about: "输出文本" },
  { name: "printf", about: "格式化输出" },
  { name: "export", about: "设置环境变量" },
  { name: "alias", about: "命令别名" },
  { name: "history", about: "命令历史" },
  { name: "date", about: "日期时间" },
  { name: "sleep", about: "延时" },
  { name: "watch", about: "周期性执行" },
  { name: "seq", about: "生成序列" },
  { name: "yes", about: "重复输出" },
  { name: "clear", about: "清屏" },
  { name: "which", about: "命令所在路径" },
  { name: "whereis", about: "命令相关文件" },
  { name: "type", about: "命令类型" },
  { name: "man", about: "手册" },
  { name: "help", about: "内建帮助" },
  { name: "screen", about: "会话保持" },
  { name: "tmux", about: "会话保持" },
  { name: "vimtutor", about: "Vim 教程" },
  { name: "openssl", about: "证书与加密" },
  { name: "ssh-keygen", about: "生成 SSH 密钥" },
  { name: "ssh-copy-id", about: "分发公钥" },
  { name: "ssh", about: "远程登录" },
  { name: "git", about: "版本控制" },
  { name: "node", about: "Node.js" },
  { name: "python3", about: "Python" },
  { name: "java", about: "Java" },
  { name: "nginx", about: "Nginx" },
  { name: "mysql", about: "MySQL 客户端" },
  { name: "redis-cli", about: "Redis 客户端" },

  // -- 性能与诊断（排查线上问题的高频命令）--------------------------------
  { name: "vmstat", about: "虚拟内存与进程统计" },
  { name: "iostat", about: "磁盘 I/O 统计" },
  { name: "mpstat", about: "分核 CPU 统计" },
  { name: "pidstat", about: "按进程统计" },
  { name: "sar", about: "历史性能数据" },
  { name: "dstat", about: "综合性能统计" },
  { name: "iotop", about: "按进程看 I/O" },
  { name: "iftop", about: "实时流量" },
  { name: "nethogs", about: "按进程看流量" },
  { name: "ncdu", about: "交互式目录占用" },
  { name: "smem", about: "按进程看内存" },
  { name: "strace", about: "跟踪系统调用" },
  { name: "ltrace", about: "跟踪库调用" },
  { name: "perf", about: "性能采样" },
  { name: "pstree", about: "进程树" },
  { name: "timeout", about: "限时执行" },
  { name: "nice", about: "调整优先级运行" },
  { name: "renice", about: "调整已运行进程优先级" },
  { name: "ionice", about: "调整 I/O 优先级" },
  { name: "lsof", about: "打开的文件" },
  { name: "fuser", about: "谁占用了文件/端口" },
  { name: "logger", about: "写 syslog" },
  { name: "lastb", about: "失败登录" },
  { name: "dmesg", about: "内核环形缓冲" },
  { name: "sysctl", about: "内核参数" },
  { name: "ulimit", about: "资源限制" },
  { name: "prlimit", about: "查看/设置进程限制" },

  // -- 存储与文件系统 -----------------------------------------------------
  { name: "lsblk", about: "块设备树" },
  { name: "blkid", about: "分区 UUID" },
  { name: "fdisk", about: "分区表（MBR）" },
  { name: "parted", about: "分区表（GPT）" },
  { name: "mkfs", about: "创建文件系统" },
  { name: "fsck", about: "检查文件系统" },
  { name: "tune2fs", about: "ext 文件系统参数" },
  { name: "resize2fs", about: "调整 ext 大小" },
  { name: "xfs_growfs", about: "扩展 xfs" },
  { name: "mdadm", about: "软 RAID" },
  { name: "lvs", about: "逻辑卷" },
  { name: "vgs", about: "卷组" },
  { name: "pvs", about: "物理卷" },
  { name: "smartctl", about: "磁盘健康" },
  { name: "e2fsck", about: "ext 检查修复" },
  { name: "chattr", about: "文件属性" },
  { name: "lsattr", about: "查看文件属性" },
  { name: "getfacl", about: "查看 ACL" },
  { name: "setfacl", about: "设置 ACL" },
  { name: "split", about: "切分文件" },
  { name: "csplit", about: "按模式切分" },
  { name: "truncate", about: "调整文件大小" },
  { name: "fallocate", about: "预分配空间" },
  { name: "dd", about: "块级复制" },
  { name: "sync", about: "刷盘" },

  // -- 文本处理补充 -------------------------------------------------------
  { name: "yq", about: "处理 YAML" },
  { name: "column", about: "列对齐" },
  { name: "paste", about: "按列合并" },
  { name: "join", about: "按键合并" },
  { name: "fold", about: "按宽度折行" },
  { name: "fmt", about: "重排段落" },
  { name: "expand", about: "Tab 转空格" },
  { name: "unexpand", about: "空格转 Tab" },
  { name: "rev", about: "逐行反转" },
  { name: "shuf", about: "随机行" },
  { name: "nl", about: "加行号" },
  { name: "od", about: "八进制查看" },
  { name: "hexdump", about: "十六进制查看" },
  { name: "xxd", about: "十六进制查看" },
  { name: "strings", about: "提取可打印字符串" },
  { name: "base64", about: "Base64 编解码" },
  { name: "md5sum", about: "MD5 校验" },
  { name: "sha256sum", about: "SHA256 校验" },
  { name: "cksum", about: "CRC 校验" },

  // -- 网络补充 -----------------------------------------------------------
  { name: "ethtool", about: "网卡参数" },
  { name: "arp", about: "ARP 表" },
  { name: "bridge", about: "网桥" },
  { name: "iperf3", about: "带宽测试" },
  { name: "ab", about: "简单压测" },
  { name: "hey", about: "HTTP 压测" },
  { name: "wrk", about: "HTTP 压测" },
  { name: "http", about: "HTTPie 客户端" },
  { name: "ssh-keyscan", about: "收集主机公钥" },
  { name: "ssh-agent", about: "密钥代理" },
  { name: "ssh-add", about: "加载私钥" },
  { name: "sshpass", about: "非交互 SSH" },
  { name: "expect", about: "交互自动化" },
  { name: "nft", about: "nftables" },
  { name: "iptables-save", about: "导出防火墙规则" },
  { name: "iptables-restore", about: "导入防火墙规则" },
  { name: "ss", about: "套接字统计" },

  // -- 数据库 / 中间件客户端 ----------------------------------------------
  { name: "psql", about: "PostgreSQL 客户端" },
  { name: "sqlite3", about: "SQLite 客户端" },
  { name: "mongo", about: "MongoDB 客户端" },
  { name: "mongosh", about: "MongoDB Shell" },
  { name: "redis-benchmark", about: "Redis 压测" },
  { name: "memcached-tool", about: "Memcached 工具" },
  { name: "kafka-topics.sh", about: "Kafka Topic 管理" },
  { name: "zookeeper-shell.sh", about: "ZK Shell" },

  // -- Web 服务 / 运行时 --------------------------------------------------
  { name: "apachectl", about: "Apache 控制" },
  { name: "httpd", about: "Apache" },
  { name: "php", about: "PHP" },
  { name: "php-fpm", about: "PHP-FPM" },
  { name: "uwsgi", about: "uWSGI" },
  { name: "gunicorn", about: "Gunicorn" },
  { name: "uvicorn", about: "Uvicorn" },
  { name: "supervisorctl", about: "Supervisor 管理" },
  { name: "pm2", about: "Node 进程管理" },

  // -- 语言与包管理 -------------------------------------------------------
  { name: "npm", about: "Node 包管理" },
  { name: "pnpm", about: "Node 包管理" },
  { name: "yarn", about: "Node 包管理" },
  { name: "bun", about: "JS 运行时" },
  { name: "npx", about: "运行 Node 包" },
  { name: "pip", about: "Python 包管理" },
  { name: "pip3", about: "Python 包管理" },
  { name: "python", about: "Python" },
  { name: "gcc", about: "C 编译器" },
  { name: "g++", about: "C++ 编译器" },
  { name: "make", about: "构建" },
  { name: "cmake", about: "构建配置" },
  { name: "cargo", about: "Rust 构建" },
  { name: "rustc", about: "Rust 编译器" },
  { name: "go", about: "Go 工具链" },
  { name: "java", about: "Java" },
  { name: "javac", about: "Java 编译器" },
  { name: "mvn", about: "Maven" },
  { name: "gradle", about: "Gradle" },
  { name: "composer", about: "PHP 包管理" },
  { name: "gem", about: "Ruby 包管理" },
  { name: "bundle", about: "Ruby 依赖" },
  { name: "perl", about: "Perl" },
  { name: "lua", about: "Lua" },

  // -- 二进制与静态分析 ---------------------------------------------------
  { name: "ldd", about: "动态库依赖" },
  { name: "nm", about: "符号表" },
  { name: "objdump", about: "反汇编" },
  { name: "readelf", about: "ELF 结构" },
  { name: "strip", about: "裁剪符号" },
  { name: "gdb", about: "调试器" },

  // -- 用户 / 会话 --------------------------------------------------------
  { name: "groups", about: "用户所属组" },
  { name: "chsh", about: "修改登录 shell" },
  { name: "visudo", about: "编辑 sudoers" },
  { name: "newgrp", about: "切换主组" },
  { name: "wall", about: "广播消息" },
  { name: "write", about: "给用户发消息" },
  { name: "chage", about: "密码有效期" },

  // -- Shell 内建 / 环境 --------------------------------------------------
  { name: "env", about: "环境变量" },
  { name: "printenv", about: "打印环境变量" },
  { name: "set", about: "Shell 变量" },
  { name: "unset", about: "删除变量" },
  { name: "read", about: "读取输入" },
  { name: "printf", about: "格式化输出" },
  { name: "test", about: "条件判断" },
  { name: "true", about: "恒真" },
  { name: "false", about: "恒假" },
  { name: "exit", about: "退出 Shell" },
  { name: "logout", about: "注销" },
  { name: "shift", about: "参数左移" },
  { name: "eval", about: "二次求值" },
  { name: "exec", about: "替换当前进程" },
  { name: "source", about: "加载脚本" },
  { name: "time", about: "计时" },
  { name: "at", about: "一次性定时任务" },
  { name: "batch", about: "空闲时执行" },
  { name: "logrotate", about: "日志轮转" },
  { name: "update-alternatives", about: "切换默认程序版本" },
  { name: "alternatives", about: "切换默认程序版本" },
  { name: "unzip", about: "解压 zip" },
  { name: "zipinfo", about: "查看 zip 内容" },
  { name: "ffmpeg", about: "音视频处理" },
  { name: "convert", about: "ImageMagick 转换" },
];

/** 输入与候选是否只差一个字符（插入 / 删除 / 替换 / 相邻换位）。 */
function oneEditApart(input: string, candidate: string): boolean {
  const a = input.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  // 相邻换位（`unizp` → `unzip`）：编辑距离算 2，但用户眼里就是敲反了两个键，
  // 必须算"差一个字符"，否则最常见的拼写错误反而纠不回来。
  if (a.length === b.length) {
    const diffs: number[] = [];
    for (let k = 0; k < a.length; k += 1) {
      if (a[k] !== b[k]) diffs.push(k);
    }
    if (diffs.length === 2) {
      const [first, second] = diffs;
      if (
        second === first + 1 &&
        a[first] === b[second] &&
        a[second] === b[first]
      ) {
        return true;
      }
    }
  }

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  // 尾巴上剩余的一个字符算一次编辑。
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function createCommandProvider(): CompletionProvider {
  return {
    id: "command",
    matches(parsed: ParsedLine): boolean {
      // 只接管命令词位置；带 `/` 是在写路径（./deploy.sh），交给文件补全。
      if (parsed.index !== 0) return false;
      if (parsed.prefix.includes("/")) return false;
      const prefix = parsed.prefix.trim();
      if (!prefix) return false;
      /*
       * **必须在这里就能命中候选**：`providerFor` 只取第一个 matches 的提供器，
       * 若对任意命令词都返回 true，知识库（真正的兜底）永远轮不到 —— 敲一个
       * 表里没有的命令就只剩空候选。前缀或一步纠错命中才接管。
       */
      return COMMANDS.some(
        (command) =>
          command.name.toLowerCase().startsWith(prefix.toLowerCase()) ||
          oneEditApart(prefix, command.name),
      );
    },
    async complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult> {
      const prefix = parsed.prefix.trim();
      const requestKey = `command:${prefix}`;
      if (!prefix) return { items: [], requestKey };

      const exact = COMMANDS.filter((command) =>
        command.name.toLowerCase().startsWith(prefix.toLowerCase()),
      );
      // 没有前缀命中时才做拼写纠错：`unizp` → `unzip`。
      const fuzzy =
        exact.length > 0
          ? []
          : COMMANDS.filter((command) => oneEditApart(prefix, command.name));

      // 命令表里可能同名重复（同类命令分在不同小节），去重后再截断。
      const seen = new Set<string>();
      const ranked = [...exact, ...fuzzy]
        .filter((command) => {
          if (seen.has(command.name)) return false;
          seen.add(command.name);
          return true;
        })
        .slice(0, 12);
      const items: CompletionItem[] = ranked.map((command, index) => ({
        label: command.name,
        // 带一个尾随空格：补完命令名就能直接接参数，少按一次空格。
        insertText: `${command.name} `,
        // `about` 以中文撰写，英文界面由 `locales/en/commands.ts` 提供译文。
        detail: i18n.t(command.about),
        icon: "command",
        type: "command",
        replaceRange: { start: 0, end: ctx.cursor },
        priority: 100 - index,
        source: "command",
        highlight: { start: 0, length: prefix.length },
      }));

      return { items, requestKey };
    },
  };
}
