import { createPublicClient, webSocket} from 'viem';
import { sepolia } from 'viem/chains';
import fs from 'fs';
import path from 'path';

// 读取logs目录，如果不存在就创建新目录
const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 按年月日来定义日志文件的名称
const LOG_FILE = path.join(LOG_DIR, `market-events-${new Date().toISOString().split('T')[0]}.log`);

// 写入日志方法
function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
  console.log(logLine.trim()); // 同时打印到控制台
}

const MARKET_CONTRACT_ADDRESS = '0x04653aBcccFA3Db8911E8Aba69924Cb0e94534d3';

// 重连配置
const RECONNECT_CONFIG = {
  maxRetries: 10,
  baseDelay: 2000, // 2秒
  maxDelay: 30000, // 30秒
  backoffMultiplier: 1.5
};

// 连接状态管理
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimeout: NodeJS.Timeout | null = null;

// 事件监听器清理函数
let currentUnsubscribeFunctions: {
  unsubscribeNFTListed?: () => void;
  unsubscribeNFTPurchased?: () => void;
} = {};

// 创建客户端的函数
function createClient() {
  return createPublicClient({
    chain: sepolia,
    transport: webSocket('wss://ethereum-sepolia.publicnode.com'), 
  });
}

// 计算重连延迟
function getReconnectDelay(): number {
  const delay = Math.min(
    RECONNECT_CONFIG.baseDelay * Math.pow(RECONNECT_CONFIG.backoffMultiplier, reconnectAttempts),
    RECONNECT_CONFIG.maxDelay
  );
  return delay;
}

// 清理事件监听器
function cleanupEventListeners() {
  if (currentUnsubscribeFunctions.unsubscribeNFTListed) {
    try {
      currentUnsubscribeFunctions.unsubscribeNFTListed();
      logToFile('已清理 NFTListed 事件监听器');
    } catch (error) {
      logToFile(`清理 NFTListed 监听器时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  if (currentUnsubscribeFunctions.unsubscribeNFTPurchased) {
    try {
      currentUnsubscribeFunctions.unsubscribeNFTPurchased();
      logToFile('已清理 NFTPurchased 事件监听器');
    } catch (error) {
      logToFile(`清理 NFTPurchased 监听器时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // 重置清理函数
  currentUnsubscribeFunctions = {};
}

// 监听事件的函数
function setupEventListeners(client: any) {
  // 监听上架事件
  const unsubscribeNFTListed = client.watchEvent({
    address: MARKET_CONTRACT_ADDRESS,
    event: {
      type: 'event',
      name: 'NFTListed',
      inputs: [
        { type: 'uint256', name: 'tokenId', indexed: true },
        { type: 'address', name: 'seller', indexed: true },
        { type: 'uint256', name: 'price', indexed: false }
      ]
    },
    onLogs: (logs: any[]) => {
      logs.forEach((log) => {
        const { tokenId, seller, price } = log.args;
        logToFile(`[上架] Token ID: ${tokenId!.toString()}, 卖家: ${seller}, 价格: ${price!.toString()} Wei`);
      });
    },
    onError: (error: Error) => {
      if (error.message.includes('socket has been closed')) {
        handleConnectionError();
      } else {
        logToFile(`NFTListed 监听错误: ${error.message}`);
      }
    },
  });

  // 监听 NFT 购买事件
  const unsubscribeNFTPurchased = client.watchEvent({
    address: MARKET_CONTRACT_ADDRESS,
    event: {
      type: 'event',
      name: 'NFTPurchased',
      inputs: [
        { type: 'uint256', name: 'tokenId', indexed: true },
        { type: 'address', name: 'buyer', indexed: true },
        { type: 'address', name: 'seller', indexed: true },
        { type: 'uint256', name: 'price', indexed: false }
      ]
    },
    onLogs: (logs: any[]) => {
      logs.forEach((log) => {
        const { tokenId, buyer, seller, price } = log.args;
        logToFile(`[成交] Token ID: ${tokenId!.toString()}, 买家: ${buyer}, 卖家: ${seller}, 价格: ${price!.toString()} Wei`);
      });
    },
    onError: (error: Error) => {
      if (error.message.includes('socket has been closed')) {
        handleConnectionError();
      } else {
        logToFile(`NFTPurchased 监听错误: ${error.message}`);
      }
    },
  });

  return { unsubscribeNFTListed, unsubscribeNFTPurchased };
}

// 处理连接错误
function handleConnectionError() {
  if (isConnected) {
    isConnected = false;
    logToFile('WebSocket 连接已断开，准备重连...');
    // 清理旧的事件监听器
    cleanupEventListeners();
    scheduleReconnect();
  }
}

// 安排重连
function scheduleReconnect() {
  if (reconnectAttempts >= RECONNECT_CONFIG.maxRetries) {
    logToFile(`已达到最大重连次数 (${RECONNECT_CONFIG.maxRetries})，停止重连`);
    process.exit(1);
    return;
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  const delay = getReconnectDelay();
  reconnectAttempts++;
  
  logToFile(`第 ${reconnectAttempts} 次重连尝试，${delay/1000} 秒后开始...`);
  
  reconnectTimeout = setTimeout(() => {
    startNFTMarketMonitoring();
  }, delay);
}

// 主监听函数
async function startNFTMarketMonitoring() {
  try {
    if (reconnectAttempts === 0) {
      logToFile('开始监听 NFTMarket 事件...');
    } else {
      logToFile(`正在进行第 ${reconnectAttempts} 次重连...`);
      // 重连前清理旧的监听器
      cleanupEventListeners();
    }

    const publicClient = createClient();
    
    // 设置事件监听
    const { unsubscribeNFTListed, unsubscribeNFTPurchased } = setupEventListeners(publicClient);
    
    // 保存清理函数到全局变量
    currentUnsubscribeFunctions = {
      unsubscribeNFTListed,
      unsubscribeNFTPurchased
    };
    
    // 标记连接成功
    isConnected = true;
    
    if (reconnectAttempts > 0) {
      logToFile(`重连成功！已恢复事件监听`);
    } else {
      logToFile('WebSocket 长连接已建立，日志将保存至: ' + LOG_FILE);
    }
    
    // 重置重连计数
    reconnectAttempts = 0;
    
    // 清理重连定时器
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

  } catch (error) {
    logToFile(`连接失败: ${error instanceof Error ? error.message : String(error)}`);
    handleConnectionError();
  }
}

// 优雅关闭处理
process.on('SIGINT', () => {
  logToFile('收到退出信号，正在关闭监听...');
  cleanupEventListeners();
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  logToFile('收到终止信号，正在关闭监听...');
  cleanupEventListeners();
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  process.exit(0);
});

// 启动
startNFTMarketMonitoring().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});