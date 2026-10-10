import { useState, useEffect, useRef, useCallback } from 'react';
import {
  watchPartyService,
  WatchPartyRole,
  WatchPartyStatus,
  WatchPartyCommand,
} from '../utils/watchParty';
import { SubtitleTrack } from '../types/media';
import { audioEngine } from '../utils/audioEngine';

interface HostMediaState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  mediaName: string;
  isAudio: boolean;
  allowGuestControl: boolean;
}

export function useWatchParty(options?: {
  mediaElement?: HTMLMediaElement | null;
  currentMediaUrl?: string;
  mediaTitle?: string;
  isAudio?: boolean;
  activeSubtitleTrack?: SubtitleTrack | null;
  onToast?: (msg: string) => void;
}) {
  const {
    mediaElement,
    currentMediaUrl,
    mediaTitle = 'Media',
    isAudio = false,
    activeSubtitleTrack = null,
    onToast,
  } = options || {};

  const [role, setRole] = useState<WatchPartyRole>(watchPartyService.getRole());
  const [roomCode, setRoomCode] = useState<string | null>(watchPartyService.getRoomCode());
  const [status, setStatus] = useState<WatchPartyStatus>(watchPartyService.getStatus());
  const [errorMessage, setErrorMessage] = useState<string | null>(watchPartyService.getErrorMessage());
  const [viewerCount, setViewerCount] = useState<number>(watchPartyService.getViewerCount());
  const [allowGuestControl, setAllowGuestControl] = useState<boolean>(true);

  // Guest-specific state
  const [incomingStream, setIncomingStream] = useState<MediaStream | null>(watchPartyService.getIncomingStream());
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  const [guestSubtitleTrack, setGuestSubtitleTrack] = useState<SubtitleTrack | null>(null);
  const [hostState, setHostState] = useState<HostMediaState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    mediaName: '',
    isAudio: false,
    allowGuestControl: true,
  });

  const lastHeartbeatRef = useRef<number>(Date.now());
  const isRemoteExecutingRef = useRef<boolean>(false);

  // Status & viewer count sync with service
  useEffect(() => {
    const unsubStatus = watchPartyService.onStatus((newStatus, errorMsg) => {
      setStatus(newStatus);
      setErrorMessage(errorMsg || null);
      setRole(watchPartyService.getRole());
      setRoomCode(watchPartyService.getRoomCode());
    });

    const unsubCount = watchPartyService.onViewerCount((count) => {
      setViewerCount(count);
    });

    const unsubStream = watchPartyService.onStream((stream) => {
      setIncomingStream(stream);
    });

    const unsubJoined = watchPartyService.onFriendJoined(() => {
      onToast?.('Friend joined');
    });

    const unsubLeft = watchPartyService.onFriendLeft(() => {
      onToast?.('Friend left');
    });

    return () => {
      unsubStatus();
      unsubCount();
      unsubStream();
      unsubJoined();
      unsubLeft();
    };
  }, [onToast]);

  // Host: capture stream and stream updates
  const updateCapturedStream = useCallback(() => {
    if (role !== 'host' || !mediaElement) return;

    try {
      const el = mediaElement as unknown as {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };

      const captured: MediaStream | null = el.captureStream
        ? el.captureStream()
        : el.mozCaptureStream
        ? el.mozCaptureStream()
        : null;

      const audioTrack = audioEngine.getCaptureAudioTrack();
      const combined = new MediaStream();

      if (!isAudio && captured) {
        captured.getVideoTracks().forEach((vt) => combined.addTrack(vt));
      }

      if (audioTrack) {
        combined.addTrack(audioTrack);
      } else if (captured && captured.getAudioTracks().length > 0) {
        captured.getAudioTracks().forEach((at) => combined.addTrack(at));
      }

      watchPartyService.setCurrentMediaStream(combined);
    } catch (err) {
      console.warn('Failed to capture stream for WatchParty:', err);
    }
  }, [role, mediaElement, isAudio]);

  useEffect(() => {
    updateCapturedStream();
  }, [updateCapturedStream, currentMediaUrl]);

  // Host: broadcast current state helper
  const broadcastCurrentState = useCallback(() => {
    if (role !== 'host') return;
    const currentState: HostMediaState = {
      isPlaying: !mediaElement?.paused,
      currentTime: mediaElement?.currentTime || 0,
      duration: mediaElement?.duration || 0,
      playbackRate: mediaElement?.playbackRate || 1,
      mediaName: mediaTitle,
      isAudio: !!isAudio,
      allowGuestControl,
    };
    watchPartyService.sendCommand({
      type: 'state',
      ...currentState,
    });
  }, [role, mediaElement, mediaTitle, isAudio, allowGuestControl]);

  // Host: Heartbeat interval (every 2 seconds)
  useEffect(() => {
    if (role !== 'host') return;

    const timer = setInterval(() => {
      if (role === 'host') {
        watchPartyService.sendCommand({
          type: 'heartbeat',
          timestamp: Date.now(),
          isPlaying: !mediaElement?.paused,
          currentTime: mediaElement?.currentTime || 0,
          duration: mediaElement?.duration || 0,
          playbackRate: mediaElement?.playbackRate || 1,
          mediaName: mediaTitle,
          isAudio: !!isAudio,
          allowGuestControl,
        });
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [role, mediaElement, mediaTitle, isAudio, allowGuestControl]);

  // Host: Broadcast subtitles when changed
  useEffect(() => {
    if (role !== 'host') return;
    watchPartyService.sendCommand({
      type: 'subtitles',
      track: activeSubtitleTrack
        ? {
            name: activeSubtitleTrack.name,
            cues: activeSubtitleTrack.cues,
            delaySeconds: activeSubtitleTrack.delaySeconds,
          }
        : null,
    });
  }, [role, activeSubtitleTrack]);

  // Command handlers
  useEffect(() => {
    const unsubCmd = watchPartyService.onCommand((cmd: WatchPartyCommand) => {
      if (cmd.type === 'heartbeat' || cmd.type === 'state') {
        lastHeartbeatRef.current = Date.now();
        setIsReconnecting(false);
        setHostState({
          isPlaying: cmd.isPlaying,
          currentTime: cmd.currentTime,
          duration: cmd.duration,
          playbackRate: cmd.playbackRate,
          mediaName: cmd.mediaName,
          isAudio: cmd.isAudio,
          allowGuestControl: cmd.allowGuestControl,
        });
      } else if (cmd.type === 'subtitles') {
        if (cmd.track) {
          setGuestSubtitleTrack({
            id: 'synced-subtitles',
            name: cmd.track.name,
            cues: cmd.track.cues,
            delaySeconds: cmd.track.delaySeconds,
          });
        } else {
          setGuestSubtitleTrack(null);
        }
      } else if (cmd.type === 'control') {
        // Host applies guest control
        if (role === 'host' && allowGuestControl && mediaElement) {
          isRemoteExecutingRef.current = true;
          try {
            if (cmd.action === 'play') {
              audioEngine.resume();
              mediaElement.play().catch(console.warn);
            } else if (cmd.action === 'pause') {
              mediaElement.pause();
            } else if (cmd.action === 'seek' && typeof cmd.time === 'number') {
              mediaElement.currentTime = cmd.time;
            } else if (cmd.action === 'rate' && typeof cmd.rate === 'number') {
              mediaElement.playbackRate = cmd.rate;
            }
          } finally {
            setTimeout(() => {
              isRemoteExecutingRef.current = false;
              broadcastCurrentState();
            }, 100);
          }
        }
      }
    });

    return () => unsubCmd();
  }, [role, allowGuestControl, mediaElement, broadcastCurrentState]);

  // Guest: 8s heartbeat watchdog
  useEffect(() => {
    if (role !== 'guest' || status !== 'connected') {
      setIsReconnecting(false);
      return;
    }

    lastHeartbeatRef.current = Date.now();

    const watchdog = setInterval(() => {
      const elapsed = Date.now() - lastHeartbeatRef.current;
      if (elapsed > 8000) {
        setIsReconnecting(true);
      } else {
        setIsReconnecting(false);
      }
    }, 1000);

    return () => clearInterval(watchdog);
  }, [role, status]);

  // Actions
  const createRoom = async (): Promise<string> => {
    const code = await watchPartyService.createRoom();
    setRole('host');
    setRoomCode(code);
    setStatus('waiting');
    onToast?.('Room created');
    // Once room is created, capture initial stream
    setTimeout(() => {
      updateCapturedStream();
    }, 300);
    return code;
  };

  const joinRoom = async (code: string): Promise<void> => {
    await watchPartyService.joinRoom(code);
    setRole('guest');
    setRoomCode(code.toUpperCase());
    setStatus('connected');
  };

  const leaveRoom = () => {
    watchPartyService.leave();
    setRole(null);
    setRoomCode(null);
    setIncomingStream(null);
    setStatus('idle');
    setErrorMessage(null);
    setViewerCount(0);
    setIsReconnecting(false);
  };

  const sendGuestControl = (action: 'play' | 'pause' | 'seek' | 'rate', time?: number, rate?: number) => {
    if (role === 'guest') {
      watchPartyService.sendCommand({
        type: 'control',
        action,
        time,
        rate,
      });
    }
  };

  return {
    role,
    roomCode,
    status,
    errorMessage,
    viewerCount,
    incomingStream,
    isReconnecting,
    hostState,
    guestSubtitleTrack,
    allowGuestControl,
    setAllowGuestControl,
    createRoom,
    joinRoom,
    leaveRoom,
    sendGuestControl,
    broadcastCurrentState,
    updateCapturedStream,
  };
}
