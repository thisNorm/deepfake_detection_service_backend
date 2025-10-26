import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  MessageBody, ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { OfferData, AnswerData, IceCandidateData } from './audiointerface';

// 송신측이 보낸 실시간 탐지 결과 DTO (간단히 정의)
type VerdictMsg = {
  to: string;         // 상대 socketId (클라이언트에서 call-ack로 받은 값)
  callId?: string;    // 선택: 호출 구분자/로그용
  pFake: number;
  pReal: number;
  ts?: number;
};

@WebSocketGateway({
  cors: { origin: '*' },
  pingInterval: 25000,   // keep-alive
  pingTimeout: 20000,    // 끊김 감지
  maxHttpBufferSize: 1e6 // 과도한 payload 방지
})
export class AudioGate implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  private userSocketMap = new Map<string, string>(); // phoneNumber -> socketId
  private socketPhoneMap = new Map<string, string>(); // socketId -> phoneNumber
  // 간단 스로틀: 직전 verdict 전송 시각 (송신자 socketId 기준)
  private lastVerdictTs = new Map<string, number>();

  handleConnection(client: Socket) {
    console.log(`[CONNECT] 클라이언트 접속: socketId=${client.id}`);
  }

  handleDisconnect(client: Socket) {
    const phone = this.socketPhoneMap.get(client.id);
    if (phone) {
      this.userSocketMap.delete(phone);
      this.socketPhoneMap.delete(client.id);
      console.log(`[DISCONNECT] 사용자 연결 해제: phone=${phone}, socketId=${client.id}`);
    } else {
      console.log(`[DISCONNECT] 등록되지 않은 소켓 연결 해제: socketId=${client.id}`);
    }
    this.lastVerdictTs.delete(client.id);
  }

  @SubscribeMessage('register-user')
  handleRegisterUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { phoneNumber: string }
  ): void {
    this.userSocketMap.set(data.phoneNumber, client.id);
    this.socketPhoneMap.set(client.id, data.phoneNumber);
    console.log(`[REGISTER] 사용자 등록: phone=${data.phoneNumber}, socketId=${client.id}`);
  }

  @SubscribeMessage('call')
  handleCall(
    @MessageBody() data: { to: string; from: string; number: string; name: string },
    @ConnectedSocket() client: Socket
  ): void {
    const toSocketId = this.userSocketMap.get(data.to);
    const fromSocketId = client.id;
    if (toSocketId) {
      this.server.to(toSocketId).emit('call', {
        from: fromSocketId,
        number: data.number,
        name: data.name,
      });
      console.log(`[CALL] from=${data.from} (sid:${fromSocketId}) → to=${data.to} (sid:${toSocketId})`);

      this.server.to(fromSocketId).emit('call-ack', { toSocketId });
      console.log(`[CALL-ACK] toSocketId=${toSocketId} → from=${data.from}`);
    } else {
      console.log(`[CALL_FAIL] 대상자 미접속: to=${data.to} (from=${data.from})`);
    }
  }

  @SubscribeMessage('offer')
  handleOffer(@MessageBody() data: OfferData, @ConnectedSocket() client: Socket): void {
    const toSocketId = data.to;
    const fromSocketId = client.id;
    console.log(`[OFFER_REQ] from=${fromSocketId} → to=${toSocketId}`);
    if (toSocketId) {
      setTimeout(() => {
        this.server.to(toSocketId).emit('offer', { offer: data.offer, from: fromSocketId });
        console.log(`[OFFER] from=${fromSocketId} → to=${toSocketId}`);
      }, 300);
    } else {
      console.log(`[OFFER_FAIL] 대상자 소켓ID 없음: to=${data.to}`);
    }
  }

  @SubscribeMessage('answer')
  handleAnswer(@MessageBody() data: AnswerData, @ConnectedSocket() client: Socket): void {
    const toSocketId = data.to;
    const fromSocketId = client.id;
    console.log(`[ANSWER_REQ] from=${fromSocketId} → to=${toSocketId}`);
    if (toSocketId) {
      this.server.to(toSocketId).emit('answer', { answer: data.answer, from: fromSocketId });
      console.log(`[ANSWER] from=${fromSocketId} → to=${toSocketId}`);
    } else {
      console.log(`[ANSWER_FAIL] 대상자 소켓ID 없음: to=${data.to}`);
    }
  }

  @SubscribeMessage('ice')
  handleIce(@MessageBody() data: IceCandidateData, @ConnectedSocket() client: Socket): void {
    const toSocketId = data.to;
    const fromSocketId = client.id;
    if (toSocketId) {
      this.server.to(toSocketId).emit('ice', { candidate: data.candidate, from: fromSocketId });
      console.log(`[ICE] from=${fromSocketId} → to=${toSocketId}`);
    } else {
      console.log(`[ICE_FAIL] 대상자 소켓ID 없음: to=${data.to}`);
    }
  }

  @SubscribeMessage('hangup')
  handleHangup(@MessageBody() data: { to: string; from: string }, @ConnectedSocket() client: Socket): void {
    const toSocketId = this.userSocketMap.get(data.to);
    if (toSocketId) {
      this.server.to(toSocketId).emit('call-ended');
      this.server.to(client.id).emit('call-ended');
      console.log(`[HANGUP] from=${data.from} → to=${data.to}`);
    } else {
      console.log(`[HANGUP_FAIL] 대상 미접속: to=${data.to}`);
    }
  }

  /** ✅ 송신측이 보낸 실시간 탐지 결과를 상대에게 그대로 전달 */
  @SubscribeMessage('deepfake-verdict')
  handleDeepfakeVerdict(@MessageBody() msg: VerdictMsg, @ConnectedSocket() client: Socket): void {
    const from = client.id;
    const to = msg?.to;

    if (!to) {
      console.log(`[VERDICT_FAIL] 'to'가 비어있음 (from=${from})`);
      return;
    }

    // 간단 유효성 검사 + 클램프
    const pFake = Number.isFinite(msg.pFake) ? Math.max(0, Math.min(1, msg.pFake)) : NaN;
    const pReal = Number.isFinite(msg.pReal) ? Math.max(0, Math.min(1, msg.pReal)) : NaN;
    if (!Number.isFinite(pFake) || !Number.isFinite(pReal)) {
      console.log(`[VERDICT_FAIL] 유효하지 않은 확률값 (from=${from}, to=${to})`, msg);
      return;
    }

    // 대상 소켓이 현재 존재하는지 확인
    const toSocket = this.server.sockets.sockets.get(to);
    if (!toSocket) {
      console.log(`[VERDICT_DROP] 대상 소켓 없음 (to=${to}, from=${from})`);
      return;
    }

    // 초간단 스로틀(기본 hop 500ms 기준으로 200ms 미만 드랍)
    const now = msg.ts ?? Date.now();
    const last = this.lastVerdictTs.get(from) ?? 0;
    if (now - last < 200) {
      // 너무 잦으면 드랍(네트워크/서버 안정성)
      return;
    }
    this.lastVerdictTs.set(from, now);

    this.server.to(to).emit('deepfake-verdict', {
      from,
      callId: msg.callId,
      pFake,
      pReal,
      ts: now,
    });
    console.log(
      `[VERDICT] ${from} → ${to} callId=${msg.callId ?? '-'} pFake=${pFake.toFixed(3)} pReal=${pReal.toFixed(3)}`
    );

    // 디버깅/메트릭용 에코(선택): 송신자에도 ack
    // this.server.to(from).emit('deepfake-verdict-ack', { ok: true, ts: now });
  }
}
