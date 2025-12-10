import {
	Injectable,
	OnModuleDestroy,
	OnModuleInit,
	Logger,
} from "@nestjs/common";
import { Kafka, Consumer } from "kafkajs";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConsumerInstance } from "./entities/consumer-instance.entity";
// 1. Import Entity và Enum Log
import { ConsumerLog, ConsumerLogStatus } from "./entities/consumer-log.entity";
import { ConsumersGateway } from "./consumers.gateway";

@Injectable()
export class DynamicConsumerService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(DynamicConsumerService.name);
	private kafka: Kafka;
	private activeConsumers: Map<string, Consumer> = new Map();

	constructor(
		@InjectRepository(ConsumerInstance)
		private instanceRepo: Repository<ConsumerInstance>,
		// 2. Inject Repository Log để lưu tin nhắn
		@InjectRepository(ConsumerLog)
		private logRepo: Repository<ConsumerLog>,
		// 3. Inject Gateway để emit WebSocket events
		private gateway: ConsumersGateway
	) {}

	onModuleInit() {
		this.kafka = new Kafka({
			clientId: "dynamic-manager",
			brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
		});

		this.restoreActiveConsumers();
	}

	async onModuleDestroy() {
		for (const consumer of this.activeConsumers.values()) {
			await consumer.disconnect();
		}
	}

	private async restoreActiveConsumers() {
		try {
			// Logic restore nếu cần (để trống tạm thời theo yêu cầu giữ nguyên logic cũ)
		} catch (error) {}
	}

	/**
	 * TẠO CONSUMER NÂNG CAO (Đã thêm logic lưu Log)
	 */
	async createAdvancedConsumer(
		groupId: string,
		topics: string[],
		instanceCount: number
	) {
		this.logger.log(
			`[Dynamic] Tạo Group: ${groupId} | Topics: ${topics} | Instance: ${instanceCount}`
		);

		const results: string[] = [];

		for (let i = 0; i < instanceCount; i++) {
			const instanceId = `${groupId}-inst-${i}`;

			if (this.activeConsumers.has(instanceId)) {
				this.logger.warn(`Instance ${instanceId} đã chạy, update DB.`);
				await this.saveInstanceToDB(instanceId, groupId, topics, "active");
				continue;
			}

			try {
				const consumer = this.kafka.consumer({ groupId: groupId });
				await consumer.connect();
				await consumer.subscribe({ topics: topics, fromBeginning: true });

				// Store consumer instance trước khi chạy
				this.activeConsumers.set(instanceId, consumer);
				await this.saveInstanceToDB(instanceId, groupId, topics, "active");

				// --- LOGIC NHẬN VÀ LƯU TIN NHẮN (CHẠY BACKGROUND - KHÔNG AWAIT) ---
				// Chạy background để API trả về ngay, consumer sẽ tiếp tục nhận message
				consumer
					.run({
						eachMessage: async ({ topic, partition, message }) => {
							const value = message.value ? message.value.toString() : "";
							const offset = message.offset;

							this.logger.debug(`[${instanceId}] Nhận tin: ${value}`);

							// Lưu message vào DB
							await this.saveMessageToDB(
								instanceId,
								groupId,
								topic,
								partition,
								offset,
								value
							);

							// Emit WebSocket event để hiện toast trên frontend
							this.gateway.broadcastMessageReceived(`${instanceId}-${offset}`, {
								consumerId: instanceId,
								groupId,
								topic,
								partition,
								offset,
								value,
								timestamp: new Date().toISOString(),
							});
						},
					})
					.catch((error) => {
						this.logger.error(`Consumer ${instanceId} error:`, error);
					});

				results.push(instanceId);
			} catch (error) {
				this.logger.error(`Lỗi tạo instance ${instanceId}:`, error);
				await this.saveInstanceToDB(instanceId, groupId, topics, "ERROR");
			}
		}

		return {
			success: true,
			message: `Đã khởi chạy ${results.length}/${instanceCount} instances.`,
			instances: results,
		};
	}

	// --- HÀM MỚI: LƯU MESSAGE VÀO DB ---
	private async saveMessageToDB(
		consumerId: string,
		groupId: string,
		topic: string,
		partition: number,
		offset: string,
		value: string
	) {
		try {
			// Thử parse JSON để lấy ID gốc nếu có (cho đẹp data), không thì random
			let originalLogId = `unknown-${Date.now()}`;
			try {
				const parsed = JSON.parse(value);
				if (parsed.id || parsed.transactionId) {
					originalLogId = parsed.id || parsed.transactionId;
				}
			} catch (e) {}

			// Tạo Entity theo đúng cấu trúc bạn đã gửi trong consumer-log.entity.ts
			const log = this.logRepo.create({
				consumerId: consumerId,
				groupId: groupId,
				originalLogId: originalLogId, // Field này bắt buộc trong entity của bạn
				topic: topic,
				partition: partition,
				offset: offset,
				data: value, // Lưu toàn bộ nội dung tin nhắn
				status: ConsumerLogStatus.PROCESSED, // Đánh dấu là đã xử lý thành công
				// timestamp tự động tạo
			});

			await this.logRepo.save(log);
			// this.logger.verbose(`Đã lưu log offset ${offset}`);
		} catch (error) {
			this.logger.error(`Lỗi lưu Log DB: ${error.message}`);
		}
	}

	// Helper: Lưu trạng thái Instance (Giữ nguyên logic cũ)
	private async saveInstanceToDB(
		instanceId: string,
		groupId: string,
		topics: string[],
		status: string
	) {
		try {
			const instanceData = {
				id: instanceId,
				groupId: groupId,
				topics: topics.join(","),
				status: status,
				topicName: topics[0],
				pid: 0,
				lastHeartbeat: new Date(),
				isDeleted: false,
			};

			const existing = await this.instanceRepo.findOne({
				where: { id: instanceId },
			});

			if (existing) {
				await this.instanceRepo.update(
					{ id: instanceId },
					{ ...instanceData, updatedAt: new Date() }
				);
			} else {
				const instance = this.instanceRepo.create(instanceData);
				await this.instanceRepo.save(instance);
			}
		} catch (error) {
			this.logger.error(`Lỗi lưu Instance DB: ${error.message}`);
		}
	}

	async stopGroup(groupId: string) {
		const keysToRemove: string[] = [];

		this.logger.log(`[Dynamic] Bắt đầu quy trình dừng Group: ${groupId}`);

		// 1. Duyệt qua tất cả active consumers
		for (const [key, consumer] of this.activeConsumers) {
			// Kiểm tra key có thuộc group cần xóa không
			if (key === groupId || key.startsWith(`${groupId}-`)) {
				try {
					this.logger.log(`[Dynamic] Đang ngắt kết nối: ${key}`);

					// A. Ngắt kết nối mạng trước
					await consumer.disconnect();

					// B. Stop consumer (quan trọng để không rejoin)
					await consumer.stop();
				} catch (e: any) {
					this.logger.error(`Lỗi khi dừng consumer ${key}: ${e.message}`);
				}

				keysToRemove.push(key);

				// 2. Cập nhật DB thành INACTIVE ngay lập tức
				try {
					// Tìm theo ID (chính xác là key trong map)
					const instance = await this.instanceRepo.findOne({
						where: { id: key },
					});
					if (instance) {
						instance.status = "INACTIVE"; // Hoặc Enum ConsumerInstanceStatus.INACTIVE
						instance.shouldStop = true; // Đánh dấu cờ stop
						await this.instanceRepo.save(instance);
					}
				} catch (e) {
					this.logger.error(`Lỗi update DB status ${key}`, e);
				}
			}
		}

		// 3. Xóa khỏi bộ nhớ RAM (Để nó không bao giờ tìm lại được)
		if (keysToRemove.length > 0) {
			keysToRemove.forEach((k) => {
				this.activeConsumers.delete(k);
				this.logger.log(`[Dynamic] Đã xóa ${k} khỏi bộ nhớ Active Map.`);
			});
			return {
				success: true,
				stopped: keysToRemove.length,
				message: `Đã dừng ${keysToRemove.length} instance.`,
			};
		} else {
			this.logger.warn(
				`[Dynamic] Không tìm thấy instance nào thuộc group ${groupId} đang chạy.`
			);
			return { success: false, message: "Không tìm thấy instance đang chạy." };
		}
	}

	async stopInstance(consumerId: string) {
		this.logger.log(`[Dynamic] Yêu cầu dừng instance: ${consumerId}`);

		const consumer = this.activeConsumers.get(consumerId);

		if (consumer) {
			try {
				// 1. Ngắt kết nối mạng
				await consumer.disconnect();
				// 2. Dừng vòng lặp xử lý (Quan trọng)
				await consumer.stop();

				// 3. Xóa khỏi bộ nhớ quản lý
				this.activeConsumers.delete(consumerId);

				this.logger.log(`[Dynamic] 🛑 Đã kill process consumer: ${consumerId}`);
			} catch (error) {
				this.logger.error(`Lỗi khi dừng consumer ${consumerId}:`, error);
			}
		} else {
			this.logger.warn(
				`[Dynamic] Không tìm thấy process đang chạy cho: ${consumerId}`
			);
		}
	}
}
