import {
  Bluetooth,
  CircleUserRound,
  History,
  Lock,
  Mic,
  MicOff,
  PlugZap,
  UserRound,
  Wifi,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const ROBOT_ID = import.meta.env.VITE_ROBOT_ID || 'test-robot';

const initialHistory = [
  { id: 1, time: '09:18', command: '招手', result: '已招手' },
  { id: 2, time: '09:42', command: '出库巡游', result: '已出库' },
  { id: 3, time: '10:06', command: '回到猫窝', result: '已入库' },
];

function App() {
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('register');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState(initialHistory);
  const [activeConnection, setActiveConnection] = useState(null);
  const [connections, setConnections] = useState({
    wifi: 'connected',
    bluetooth: 'connected',
  });
  const [isRecording, setIsRecording] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isInterrupted, setIsInterrupted] = useState(false);
  const [activeVideo, setActiveVideo] = useState('idle');
  const [statusText, setStatusText] = useState('点击麦克风开始说话');
  const [micError, setMicError] = useState('');
  const mediaRecorderRef = useRef(null);
  const recognitionRef = useRef(null);
  const recognitionFinalRef = useRef('');
  const streamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const abortRef = useRef(null);
  const discardRecordingRef = useRef(false);

  const connectionItems = useMemo(
    () => [
      { key: 'wifi', label: 'Wi-Fi', description: '本地大模型通道', endpoint: 'http://localhost:3002', icon: Wifi },
      { key: 'bluetooth', label: '蓝牙', description: '机器猫设备连接', endpoint: 'ESP32CAT', icon: Bluetooth },
    ],
    [],
  );

  useEffect(() => {
    return () => {
      stopTracks();
      stopBrowserRecognition(true);
      abortRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (activeVideo !== 'warehouseIn') return undefined;

    const fallbackTimer = window.setTimeout(() => {
      setActiveVideo('idle');
    }, 12000);

    return () => window.clearTimeout(fallbackTimer);
  }, [activeVideo]);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const addHistoryItem = (command, result = '已执行') => {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    setHistoryItems((current) => [
      {
        id: now.getTime(),
        time,
        command: command || '语音指令',
        result,
      },
      ...current,
    ].slice(0, 20));
  };

  const updateConnection = (key) => {
    setConnections((current) => {
      if (current[key] === 'connected') {
        return { ...current, [key]: 'disconnected' };
      }

      return { ...current, [key]: 'connecting' };
    });

    if (connections[key] !== 'connected') {
      window.setTimeout(() => {
        setConnections((current) => ({ ...current, [key]: 'connected' }));
      }, 900);
    }
  };

  const startRecording = async () => {
    if (isThinking) {
      interruptReply();
    }

    setMicError('');
    setIsInterrupted(false);

    if (canUseBrowserSpeechRecognition()) {
      startBrowserRecognition();
      return;
    }

    await startMediaRecording();
  };

  const startBrowserRecognition = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();

    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognitionFinalRef.current = '';

    recognition.onstart = () => {
      recognitionRef.current = recognition;
      setIsRecording(true);
      setStatusText('正在聆听，你可以开始说话');
    };

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0].transcript;
        if (event.results[index].isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      if (finalText) {
        recognitionFinalRef.current = `${recognitionFinalRef.current}${finalText}`.trim();
      }

      const visibleText = `${recognitionFinalRef.current} ${interimText}`.trim();
      if (visibleText) {
        setStatusText(visibleText);
      }
    };

    recognition.onerror = (event) => {
      setIsRecording(false);
      recognitionRef.current = null;

      if (event.error === 'not-allowed') {
        setMicError('需要允许麦克风权限');
        setStatusText('麦克风权限被拒绝');
        return;
      }

      if (event.error === 'no-speech') {
        setMicError('没有听到声音，请靠近一点再试');
        setStatusText('没有听到声音');
        return;
      }

      setMicError('浏览器语音识别不可用，已尝试录音模式');
      void startMediaRecording();
    };

    recognition.onend = () => {
      const text = recognitionFinalRef.current.trim();
      recognitionRef.current = null;
      setIsRecording(false);

      if (discardRecordingRef.current) {
        discardRecordingRef.current = false;
        recognitionFinalRef.current = '';
        return;
      }

      if (text) {
        void processUserInput(text, { source: 'browser-speech' });
      } else {
        setStatusText('没有识别到内容，再试一次');
      }
    };

    try {
      recognition.start();
    } catch {
      setMicError('浏览器语音识别启动失败，已尝试录音模式');
      void startMediaRecording();
    }
  };

  const stopBrowserRecognition = (discard = false) => {
    if (!recognitionRef.current) return false;

    discardRecordingRef.current = discard;
    try {
      recognitionRef.current.stop();
    } catch {
      recognitionRef.current = null;
      setIsRecording(false);
    }
    return true;
  };

  const startMediaRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);

      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const shouldDiscard = discardRecordingRef.current;
        discardRecordingRef.current = false;
        stopTracks();
        setIsRecording(false);

        if (shouldDiscard) {
          audioChunksRef.current = [];
          return;
        }

        if (audioBlob.size > 0) {
          void submitVoice(audioBlob);
        } else {
          setStatusText('没有录到声音，再试一次');
        }
      };

      recorder.start();
      setIsRecording(true);
      setStatusText('正在录音，再点一次发送');
    } catch (error) {
      setIsRecording(false);
      setMicError('需要允许麦克风权限');
      setStatusText(error.name === 'NotAllowedError' ? '麦克风权限被拒绝' : '无法打开麦克风');
    }
  };

  const stopRecording = () => {
    if (stopBrowserRecognition(false)) {
      setStatusText('正在整理你说的话');
      return;
    }

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      setStatusText('正在识别');
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
      return;
    }

    void startRecording();
  };

  const submitVoice = async (audioBlob) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setIsThinking(true);
    setStatusText('正在识别语音');

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const speechResponse = await fetch(`${API_BASE}/speech-to-text`, {
        method: 'POST',
        body: formData,
        signal: abortRef.current.signal,
      });

      if (!speechResponse.ok) {
        throw new Error('语音识别失败');
      }

      const speechData = await speechResponse.json();
      const userInput = (speechData.text || '').trim();

      if (!userInput) {
        setStatusText('没有识别到内容');
        return;
      }

      await processUserInput(userInput, { source: 'server-speech' });
    } catch (error) {
      if (error.name !== 'AbortError') {
        setStatusText('语音识别没有返回文字');
        setMicError(error.message);
      }
    } finally {
      setIsThinking(false);
    }
  };

  const processUserInput = async (userInput, meta = {}) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setIsThinking(true);
    setMicError('');
    setStatusText(userInput);

    const localResult = inferActionResult(userInput);

    if (localResult !== '已执行') {
      addHistoryItem(userInput, localResult);
      if (shouldPlayWarehouseIn(userInput, null, '', localResult)) {
        playWarehouseInAnimation();
      }
    }

    try {
      const chatResponse = await fetch(`${API_BASE}/interaction/${ROBOT_ID}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userInput, source: meta.source }),
        signal: abortRef.current.signal,
      });

      if (!chatResponse.ok) {
        throw new Error('对话接口不可用');
      }

      const chatData = await chatResponse.json();
      const reply = chatData.responseText || chatData.response || chatData.text || '收到';
      const actionResult = inferActionResult(userInput, chatData);

      if (localResult === '已执行') {
        addHistoryItem(userInput, actionResult);
      }

      if (shouldPlayWarehouseIn(userInput, chatData, reply, actionResult)) {
        playWarehouseInAnimation();
      }

      setStatusText(reply);
      speak(reply);
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (localResult === '已执行') {
          addHistoryItem(userInput, '已记录');
        }
        setStatusText(`听到了：${userInput}`);
        setMicError('已听到语音，本地后端暂时没有回应');
      }
    } finally {
      setIsThinking(false);
    }
  };

  const speak = (text) => {
    if (!('speechSynthesis' in window) || !text) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    utterance.pitch = 1.05;
    window.speechSynthesis.speak(utterance);
  };

  const sendCommand = async (action) => {
    try {
      await fetch(`${API_BASE}/interaction/${ROBOT_ID}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch {
      // 即使后端暂时离线，也要允许前端立即停止本地播放。
    }
  };

  const interruptReply = () => {
    abortRef.current?.abort();
    window.speechSynthesis?.cancel();
    if (isRecording) {
      discardRecordingRef.current = true;
      if (!stopBrowserRecognition(true)) {
        stopRecording();
      }
    }
    setIsThinking(false);
    setIsInterrupted(true);
    setStatusText('已打断');
    void sendCommand('stop');
  };

  const closeSession = () => {
    interruptReply();
    setStatusText('已关闭');
  };

  const playWarehouseInAnimation = () => {
    setActiveVideo('warehouseIn');
  };

  const handleWarehouseInEnded = () => {
    setActiveVideo('idle');
  };

  return (
    <main className="machinecat-app" aria-label="MachineCat voice interface">
      {activeVideo === 'warehouseIn' ? (
        <video
          className="sayhi-video"
          key="warehouse-in"
          src="/warehouse-in.mp4"
          autoPlay
          playsInline
          muted
          onEnded={handleWarehouseInEnded}
        />
      ) : (
        <video className="sayhi-video" key="sayhi" src="/sayhi.mp4" autoPlay playsInline muted loop />
      )}

      <div className="top-fade" />
      <div className="bottom-fade" />

      <header className="topbar">
        <div className="top-left-cluster">
          <button className="identity-button" type="button" onClick={() => setAuthOpen(true)} aria-label="账号和设置">
            <span className="identity-avatar">
              <CircleUserRound size={24} strokeWidth={1.9} />
            </span>
            <span className="identity-copy">
              <strong>小白</strong>
              <span>{ROBOT_ID}</span>
            </span>
          </button>

          <button className="history-button" type="button" onClick={() => setHistoryOpen(true)} aria-label="历史记录">
            <History size={24} strokeWidth={2.2} />
          </button>
        </div>

        <div className="connection-cluster" aria-label="连接状态">
          {connectionItems.map(({ key, label, icon: Icon }) => (
            <button
              className={`connection-button ${connections[key]}`}
              key={key}
              type="button"
              onClick={() => setActiveConnection(key)}
              aria-label={`${label}${connectionLabel(connections[key])}`}
            >
              <Icon size={25} strokeWidth={2.2} />
              <span className="status-ring" />
            </button>
          ))}
        </div>
      </header>

      <button className="interrupt-button" type="button" onClick={interruptReply}>
        点击打断
      </button>

      <p className="status-line">{statusText}</p>
      {micError && <p className="error-line">{micError}</p>}

      <nav className="control-dock" aria-label="语音控制">
        <button className="dock-button close-button" type="button" onClick={closeSession} aria-label="关闭">
          <X size={21} strokeWidth={3} />
        </button>

        <div className="dock-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <button
          className={`mic-button ${isRecording ? 'recording' : ''}`}
          type="button"
          onClick={toggleRecording}
          aria-label={isRecording ? '停止录音' : '开始录音'}
          aria-pressed={isRecording}
        >
          {isRecording ? <Mic size={23} strokeWidth={2.4} /> : <MicOff size={23} strokeWidth={2.4} />}
        </button>
      </nav>

      {authOpen && (
        <AuthSheet
          mode={authMode}
          onModeChange={setAuthMode}
          onClose={() => setAuthOpen(false)}
        />
      )}

      {historyOpen && (
        <HistorySheet
          items={historyItems}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {activeConnection && (
        <ConnectionSheet
          connection={connectionItems.find((item) => item.key === activeConnection)}
          status={connections[activeConnection]}
          onToggle={() => updateConnection(activeConnection)}
          onClose={() => setActiveConnection(null)}
        />
      )}
    </main>
  );
}

function canUseBrowserSpeechRecognition() {
  return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
}

function inferActionResult(userInput, chatData = null) {
  const text = `${userInput} ${JSON.stringify(chatData || {})}`;
  if (text.includes('出库')) return '已出库';
  if (text.includes('入库') || text.includes('回') || text.includes('猫窝')) return '已入库';
  if (text.includes('招手')) return '已招手';
  if (text.includes('停')) return '已停止';
  return '已执行';
}

function shouldPlayWarehouseIn(userInput, chatData, reply, actionResult) {
  const text = `${userInput} ${reply} ${actionResult} ${JSON.stringify(chatData || {})}`;
  return text.includes('入库');
}

function connectionLabel(status) {
  return {
    connected: '已连接',
    connecting: '连接中',
    disconnected: '未连接',
  }[status];
}

function ConnectionSheet({ connection, status, onToggle, onClose }) {
  const Icon = connection.icon;
  const connected = status === 'connected';
  const connecting = status === 'connecting';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="connection-sheet" role="dialog" aria-modal="true" aria-label={`${connection.label}连接状态`} onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <header className="sheet-header">
          <span className={`sheet-large-icon ${status}`}>
            <Icon size={28} />
          </span>
          <div>
            <h2>{connection.label}</h2>
            <p>{connection.description}</p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>

        <div className="connection-state">
          <span>当前状态</span>
          <strong>{connectionLabel(status)}</strong>
          <small>{connected ? '链路稳定，可以继续同步控制。' : connecting ? '正在尝试重新建立连接。' : '已断开，控制指令会暂停同步。'}</small>
        </div>

        <div className="connection-meta">
          <div>
            <span>设备</span>
            <strong>{connection.endpoint}</strong>
          </div>
          <div>
            <span>最近同步</span>
            <strong>{connected ? '刚刚' : '--'}</strong>
          </div>
        </div>

        <button className={`connection-action ${connected ? 'disconnect' : ''}`} type="button" onClick={onToggle} disabled={connecting}>
          <PlugZap size={18} />
          {connected ? `断开${connection.label}` : connecting ? '连接中' : `重新连接${connection.label}`}
        </button>
      </section>
    </div>
  );
}

function HistorySheet({ items, onClose }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="history-sheet" role="dialog" aria-modal="true" aria-label="语音执行记录" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <header className="sheet-header">
          <span className="sheet-large-icon">
            <History size={28} />
          </span>
          <div>
            <h2>历史记录</h2>
            <p>语音输入让机器猫执行的动作。</p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>

        <div className="history-list" aria-label="执行记录列表">
          {items.map((item) => (
            <article className="history-item" key={item.id}>
              <time>{item.time}</time>
              <div>
                <strong>{item.command}</strong>
                <span>{item.result}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function AuthSheet({ mode, onModeChange, onClose }) {
  const isRegister = mode === 'register';

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="auth-sheet" role="dialog" aria-modal="true" aria-label={isRegister ? '注册账号' : '登录账号'} onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <header className="sheet-header">
          <div>
            <h2>{isRegister ? '注册' : '登录'}</h2>
            <p>{isRegister ? '创建账号，连接你的机器猫。' : '欢迎回来，继续连接机器猫。'}</p>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="关闭">
            <X size={20} />
          </button>
        </header>

        <form className="auth-form">
          <label className="auth-field">
            <UserRound size={19} />
            <input type="text" placeholder="用户名（3-30位）" autoComplete="username" />
          </label>
          <label className="auth-field">
            <Lock size={19} />
            <input type="password" placeholder="密码（至少6位）" autoComplete={isRegister ? 'new-password' : 'current-password'} />
          </label>
          {isRegister && (
            <label className="auth-field">
              <Lock size={19} />
              <input type="password" placeholder="确认密码" autoComplete="new-password" />
            </label>
          )}

          <button className="auth-submit" type="button">
            {isRegister ? '注册' : '登录'}
          </button>
        </form>

        <button className="auth-switch" type="button" onClick={() => onModeChange(isRegister ? 'login' : 'register')}>
          {isRegister ? '已有账号，立即登录' : '还没有账号，立即注册'}
        </button>
      </section>
    </div>
  );
}

export default App;
