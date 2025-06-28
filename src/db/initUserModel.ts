import mongoose from 'mongoose';

export function initUserModel(connection: mongoose.Connection) {
  const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
  }, {
    timestamps: true
  });

  if (connection.models.User) {
    return connection.models.User;
  }

  return connection.model('User', userSchema);
}
